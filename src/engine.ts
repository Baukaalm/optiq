import { classify } from "./classify.js";
import type { CodecBackend, EncodeSettings } from "./codecs/types.js";
import { buildOrientationExif, withOrientation } from "./container/exif.js";
import { decodeGifFirstFrame } from "./container/gif.js";
import { tagAvifSrgb } from "./container/isobmff.js";
import { injectJpegMetadata, rewriteJpegMetadata } from "./container/jpeg.js";
import { injectPngMetadata, rewritePngMetadata } from "./container/png.js";
import { extractFirstWebpFrame, injectWebpMetadata, probeWebp, rewriteWebpMetadata } from "./container/webp.js";
import { SmartCompressError, throwIfAborted } from "./errors.js";
import { OUTPUT_FORMATS, resolveOptions, type ResolvedOptions } from "./options.js";
import { applyOrientation, hasTransparentPixels, pixelsEqual, targetSize, tileMosaic, type RawImage } from "./pixels.js";
import { effectiveMinQuality, planCandidates, type FormatPlan } from "./plan.js";
import { displayDimensions, probe, type ProbeInfo } from "./probe.js";
import { ssim } from "./quality.js";
import type {
  CandidateReport,
  CompressionResult,
  DetectedFormat,
  ImageCategory,
  MetadataReport,
  OutputFormat,
  ProgressEvent,
  ProgressStage,
  SmartCompressOptions,
  UnmetConstraint,
} from "./types.js";

export interface EngineContext {
  backend: CodecBackend & { readonly fallbacks?: string[] };
  signal?: AbortSignal;
  onProgress?: (e: ProgressEvent) => void;
  now?: () => number;
}

export type EngineReport = Omit<CompressionResult, "blob" | "fileName">;

export interface EngineOutput {
  /** Output bytes; `undefined` when the result is the unmodified input. */
  bytes?: Uint8Array;
  report: EngineReport;
}

interface Candidate {
  report: CandidateReport;
  bytes: Uint8Array;
  /** Bytes are identical to the input. */
  isOriginal: boolean;
  /** Candidate keeps the input container (orientation tag, animation, all frames). */
  container: boolean;
  width: number;
  height: number;
}

const MIME: Record<DetectedFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  heif: "image/heif",
  svg: "image/svg+xml",
};

function placeOnCanvas(frame: RawImage, x: number, y: number, width: number, height: number): RawImage {
  if (x === 0 && y === 0 && frame.width === width && frame.height === height) return frame;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < frame.height && y + row < height; row++) {
    const w = Math.min(frame.width, width - x);
    if (w <= 0) break;
    data.set(frame.data.subarray(row * frame.width * 4, (row * frame.width + w) * 4), ((y + row) * width + x) * 4);
  }
  return { data, width, height };
}

function isLosslessWebp(b: Uint8Array): boolean {
  try {
    return probeWebp(b).lossless;
  } catch {
    return false;
  }
}

export function mimeTypeOf(format: DetectedFormat): string {
  return MIME[format];
}

/** Above this many pixels, perceptual quality search runs on a tile mosaic (see `tileMosaic`). */
const PROXY_MIN_PIXELS = 4_000_000;

const isOutputFormat = (f: string): f is OutputFormat => (OUTPUT_FORMATS as readonly string[]).includes(f);

function incompatible(message: string, details?: Record<string, unknown>): never {
  throw new SmartCompressError("INCOMPATIBLE_OPTIONS", message, details);
}

interface MetadataPlan {
  keepIcc: boolean;
  /** For re-encoded pixels (orientation baked, tag reset to 1). */
  pixel: { exif?: Uint8Array; xmp?: Uint8Array; icc?: Uint8Array };
  /** For container rewrites (orientation tag kept). */
  container: { exif?: Uint8Array; xmp?: Uint8Array };
  /** Output formats that cannot carry the metadata that must be kept. */
  cannotCarry: { format: OutputFormat; reason: string }[];
}

function metadataPlan(info: ProbeInfo, opts: ResolvedOptions): MetadataPlan {
  const keepIcc = !!info.icc && (opts.preserveMetadata || !info.iccInfo?.isSrgb);
  const keep = opts.preserveMetadata;
  const plan: MetadataPlan = {
    keepIcc,
    pixel: {
      exif: keep && info.exif ? withOrientation(info.exif, 1) : undefined,
      xmp: keep ? info.xmp : undefined,
      icc: keepIcc ? info.icc : undefined,
    },
    container: {
      exif: keep ? info.exif : info.orientation !== 1 ? buildOrientationExif(info.orientation) : undefined,
      xmp: keep ? info.xmp : undefined,
    },
    cannotCarry: [],
  };
  // We cannot write ICC/EXIF/XMP into AVIF (no ISOBMFF item writer). An sRGB profile is not needed there:
  // libavif signals sRGB colour with an nclx colr box (verified in tests).
  if (keepIcc && !info.iccInfo?.isSrgb) plan.cannotCarry.push({ format: "avif", reason: `its ${info.iccInfo?.description || "non-sRGB"} ICC profile cannot be embedded in AVIF output` });
  else if (plan.pixel.exif || plan.pixel.xmp) plan.cannotCarry.push({ format: "avif", reason: "EXIF/XMP cannot be embedded in AVIF output (set preserveMetadata: false to allow AVIF)" });
  return plan;
}

async function rewriteContainer(input: Uint8Array, info: ProbeInfo, meta: MetadataPlan, opts: ResolvedOptions, warnings: string[]): Promise<Uint8Array> {
  const hasMeta = !!(info.exif || info.xmp || info.icc);
  if (opts.preserveMetadata || !hasMeta) return input;
  switch (info.format) {
    case "jpeg":
      return rewriteJpegMetadata(input, meta.container, meta.keepIcc);
    case "png":
      return rewritePngMetadata(input, meta.container, { dropIcc: !meta.keepIcc });
    case "webp":
      return rewriteWebpMetadata(input, meta.container, meta.keepIcc);
    default:
      warnings.push(`Metadata could not be removed from ${info.format.toUpperCase()} input; it is kept unchanged`);
      return input;
  }
}

async function injectMetadata(format: OutputFormat, bytes: Uint8Array, meta: MetadataPlan["pixel"]): Promise<Uint8Array> {
  switch (format) {
    case "jpeg":
      return injectJpegMetadata(bytes, meta);
    case "png":
      return injectPngMetadata(bytes, meta);
    case "webp":
      return injectWebpMetadata(bytes, meta);
    case "avif":
      // Pixels are treated as sRGB (untagged, sRGB-tagged, or non-sRGB inputs are excluded from AVIF).
      return tagAvifSrgb(bytes);
  }
}

/**
 * Optimise one image. Environment-agnostic: runs in a Worker, on the main thread, or in Node, given a codec backend.
 */
export async function optimize(input: Uint8Array, options: SmartCompressOptions | undefined, ctx: EngineContext): Promise<EngineOutput> {
  const now = ctx.now ?? (() => performance.now());
  const t0 = now();
  const opts = resolveOptions(options);
  const warnings: string[] = [];
  const candidates: Candidate[] = [];
  const proxyCandidates: Candidate[] = [];
  let tried = 0;
  let budget = opts.maxCandidates;
  const emit = (stage: ProgressStage, progress: number) => {
    const best = bestValid();
    ctx.onProgress?.({ stage, progress, candidatesTried: tried, candidateBudget: budget, bestBytes: best?.bytes.length });
  };
  const check = () => throwIfAborted(ctx.signal);
  let minQuality = opts.minQuality;
  const bestValid = (pool: Candidate[] = candidates): Candidate | undefined => {
    let best: Candidate | undefined;
    for (const c of pool) if (c.report.passed && (!best || c.bytes.length < best.bytes.length)) best = c;
    return best;
  };

  if (input.length === 0) throw new SmartCompressError("INVALID_INPUT", "Input is empty");
  if (input.length > opts.maxInputBytes) {
    throw new SmartCompressError("INPUT_TOO_LARGE", `Input is ${input.length} bytes; limit is ${opts.maxInputBytes} (maxInputBytes)`, { bytes: input.length, limit: opts.maxInputBytes });
  }
  emit("probing", 0.02);
  const info = await probe(input);
  warnings.push(...info.warnings);
  check();
  const display = displayDimensions(info);
  const meta = metadataPlan(info, opts);
  let baseline: Candidate | undefined;
  let flatten = false;

  const explicit = isOutputFormat(opts.targetFormat) ? opts.targetFormat : undefined;
  if (info.format === "heif") {
    throw new SmartCompressError(
      "UNSUPPORTED_FORMAT",
      "HEIC/HEIF is recognized but not supported: no reliable, licence-compatible browser decoder is available. Convert to JPEG on the device or server.",
    );
  }
  if (info.format === "svg") {
    if (explicit) incompatible("SVG is a vector format and is never rasterized; use targetFormat 'auto' or 'original' to pass it through");
    if (opts.maxWidthOrHeight) warnings.push("maxWidthOrHeight does not apply to SVG");
    warnings.push("SVG passed through unchanged (vector images are not rasterized or rewritten)");
    return finish(passthrough(input, info.format), undefined);
  }
  if (info.width * info.height > opts.maxInputPixels) {
    throw new SmartCompressError("INPUT_TOO_LARGE", `Image declares ${info.width}x${info.height} pixels; limit is ${opts.maxInputPixels} (maxInputPixels)`, {
      width: info.width,
      height: info.height,
      limit: opts.maxInputPixels,
    });
  }

  const needsResize = opts.maxWidthOrHeight !== undefined && Math.max(display.width, display.height) > opts.maxWidthOrHeight;
  if (needsResize && opts.mode === "lossless" && !opts.allowLossyResize) {
    incompatible("Resizing changes pixels and is not allowed in lossless mode; set allowLossyResize: true to permit it", { maxWidthOrHeight: opts.maxWidthOrHeight });
  }
  const inputAsOutput = isOutputFormat(info.format) ? info.format : undefined;

  // ---- Which output formats are allowed --------------------------------------------------------------------------
  let allowed: OutputFormat[];
  if (opts.targetFormat === "original" || !opts.allowFormatConversion) {
    if (explicit && explicit !== info.format) incompatible(`targetFormat "${explicit}" conflicts with allowFormatConversion: false for ${info.format.toUpperCase()} input`);
    allowed = inputAsOutput ? [inputAsOutput] : [];
  } else allowed = explicit ? [explicit] : [...opts.autoFormats];
  const originalAllowed = !needsResize && (opts.targetFormat === "auto" || opts.targetFormat === "original" || opts.targetFormat === info.format);
  const removeFormat = (f: OutputFormat, reason: string) => {
    if (!allowed.includes(f)) return;
    if (explicit === f) incompatible(`Cannot produce ${f.toUpperCase()}: ${reason}`);
    allowed = allowed.filter((x) => x !== f);
    warnings.push(`${f.toUpperCase()} output skipped: ${reason}`);
  };

  if (info.animated) {
    if (opts.preserveAnimation) {
      if (explicit && explicit !== info.format) incompatible(`Animated ${info.format.toUpperCase()} cannot be converted to ${explicit.toUpperCase()} without losing animation; set preserveAnimation: false to flatten it to the first frame`);
      if (needsResize) incompatible("Resizing animated images is not supported; set preserveAnimation: false to flatten to the first frame");
      if (allowed.length) warnings.push("Animated image: frames are not re-encoded; only container-level optimization was applied");
      allowed = [];
    } else {
      flatten = true;
    }
  }
  if (info.reencodeBlocker) {
    if ((explicit && explicit !== info.format) || needsResize) incompatible(`${info.reencodeBlocker}; the image cannot be re-encoded`);
    if (allowed.length) warnings.push(`${info.reencodeBlocker}; original kept`);
    allowed = [];
  }
  if (opts.mode === "lossless" && allowed.includes("jpeg")) {
    if (explicit === "jpeg" && info.format !== "jpeg") incompatible("JPEG encoding is never lossless; use png or webp, or a perceptual mode");
    allowed = allowed.filter((f) => f !== "jpeg"); // JPEG input is still optimised losslessly at container level
  }
  if (opts.mode === "lossless" && allowed.includes("avif")) {
    // libavif "lossless" in these builds is not guaranteed bit-exact (YUV matrix), and is rarely smaller than WebP.
    if (explicit === "avif") incompatible("Lossless AVIF output is not supported; use png or webp, or a perceptual mode");
    allowed = allowed.filter((f) => f !== "avif");
  }

  for (const c of meta.cannotCarry) removeFormat(c.format, c.reason);

  // ---- Container-level candidate (no pixel change) ---------------------------------------------------------------
  if (originalAllowed) {
    const bytes = await rewriteContainer(input, info, meta, opts, warnings);
    baseline = {
      report: {
        format: info.format,
        codec: bytes === input ? "original" : "container-rewrite",
        settings: {},
        bytes: bytes.length,
        quality: 1,
        qualityMetric: "exact",
        passed: true,
        durationMs: 0,
        note: bytes === input ? "unmodified input" : "metadata removed; image data copied byte-for-byte",
      },
      bytes,
      isOriginal: bytes === input,
      container: true,
      ...display,
    };
    candidates.push(baseline);
  }
  if (!allowed.length) {
    if (!baseline) incompatible("No output format can satisfy the requested options for this image");
    return finish(baseline, undefined);
  }

  // ---- Decode ----------------------------------------------------------------------------------------------------
  emit("decoding", 0.06);
  let decoded: RawImage;
  try {
    if (info.format === "gif") decoded = decodeGifFirstFrame(input);
    else if (info.format === "webp" && info.animated) {
      const f = extractFirstWebpFrame(input);
      decoded = placeOnCanvas(await ctx.backend.decode("webp", f.still), f.x, f.y, f.canvasWidth, f.canvasHeight);
    } else decoded = await ctx.backend.decode(info.format as "jpeg" | "png" | "webp" | "avif", input);
  } catch (e) {
    if (e instanceof SmartCompressError) throw e;
    throw new SmartCompressError("MALFORMED_INPUT", `Could not decode ${info.format.toUpperCase()}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (decoded.width !== info.width || decoded.height !== info.height) {
    throw new SmartCompressError("MALFORMED_INPUT", `Decoded size ${decoded.width}x${decoded.height} does not match header ${info.width}x${info.height}`);
  }
  check();
  if (flatten) warnings.push("Animation flattened to its first frame (preserveAnimation: false) unless the original is returned");
  let reference = applyOrientation(decoded, info.orientation);
  const transparent = hasTransparentPixels(reference);
  if (transparent) removeFormat("jpeg", "the image has transparent pixels and JPEG cannot store alpha");
  const pixelsExact = info.bitDepth <= 8;
  if (!pixelsExact) {
    if (opts.mode === "lossless") {
      allowed = allowed.filter((f) => f === "png" && info.format === "png");
      warnings.push(`${info.bitDepth}-bit input: only same-format lossless optimization keeps full precision`);
    } else warnings.push(`${info.bitDepth}-bit input is reduced to 8 bits per channel when re-encoded`);
  }

  let resized = false;
  if (needsResize) {
    emit("resizing", 0.1);
    const t = targetSize(reference.width, reference.height, opts.maxWidthOrHeight!);
    if (!ctx.backend.resize) throw new SmartCompressError("CODEC_UNAVAILABLE", "No resize implementation available");
    reference = await ctx.backend.resize(reference, t.width, t.height);
    resized = true;
    if (meta.pixel.exif) warnings.push("EXIF was kept; its pixel-dimension tags may still describe the original size");
    check();
  }

  emit("analyzing", 0.12);
  const { category } = classify(reference);
  minQuality = effectiveMinQuality(category, opts);
  const plans = planCandidates(
    {
      category,
      allowed,
      transparent,
      pngContainerEligible: info.format === "png" && !resized && !flatten,
      pixelsExact,
      inputLossy: info.format === "jpeg" || info.format === "avif" || (info.format === "webp" && !isLosslessWebp(input)),
    },
    opts,
  );

  // ---- Candidate search ------------------------------------------------------------------------------------------
  emit("encoding", 0.15);
  const progressOf = () => 0.15 + 0.8 * Math.min(1, tried / budget);

  // Large images: search quality on a mosaic of full-resolution tiles, then encode the winner(s) at full size and
  // verify there. Cuts full-resolution encodes (time, and WASM heap growth per codec) from ~10 to ~1-3.
  const useProxy = opts.searchStrategy === "binary" && reference.width * reference.height > PROXY_MIN_PIXELS;
  const proxyRef = useProxy ? tileMosaic(reference) : undefined;

  async function evaluate(plan: FormatPlan, settings: EncodeSettings, onProxy = false): Promise<Candidate> {
    check();
    const t = now();
    const image = onProxy && proxyRef ? proxyRef : reference;
    let bytes: Uint8Array;
    const fromContainer = plan.kind === "exact" && plan.fromContainer;
    if (fromContainer) {
      bytes = await ctx.backend.optimisePng!(input, settings);
      if (!opts.preserveMetadata) bytes = await rewritePngMetadata(bytes, meta.container, { dropIcc: !meta.keepIcc });
    } else {
      bytes = await ctx.backend.encode(plan.format, image, settings);
      if (!onProxy) bytes = await injectMetadata(plan.format, bytes, meta.pixel);
    }
    tried++;
    check();
    const out = await ctx.backend.decode(plan.format, bytes);
    const expected = fromContainer ? decoded : image;
    let quality: number;
    let passed: boolean;
    let metric: CandidateReport["qualityMetric"];
    let note: string | undefined;
    if (plan.kind === "exact") {
      metric = "exact";
      passed = pixelsEqual(expected, out);
      quality = passed ? 1 : ssim(expected, out).ssim;
      if (!passed) note = "lossless verification failed; candidate rejected";
    } else {
      metric = "ssim";
      quality = out.width === expected.width && out.height === expected.height ? ssim(expected, out).ssim : 0;
      passed = quality >= minQuality;
    }
    const c: Candidate = {
      report: {
        format: plan.format,
        codec: ctx.backend.codecName(plan.format, settings),
        settings,
        bytes: bytes.length,
        quality,
        qualityMetric: metric,
        passed,
        durationMs: Math.round(now() - t),
        proxy: onProxy || undefined,
        note: onProxy ? `quality search on ${image.width}x${image.height} tile mosaic` : note,
      },
      bytes,
      isOriginal: false,
      container: !!fromContainer,
      width: fromContainer ? display.width : image.width,
      height: fromContainer ? display.height : image.height,
    };
    (onProxy ? proxyCandidates : candidates).push(c);
    emit("encoding", progressOf());
    return c;
  }

  const unavailable = new Set<string>();
  /** A codec that cannot run (blocked WASM without a fallback, unsupported canvas type) disables that plan only. */
  async function tryEvaluate(plan: FormatPlan, settings: EncodeSettings, onProxy = false): Promise<Candidate | undefined> {
    const key = `${plan.format}:${settings.lossless === true}`;
    if (unavailable.has(key)) return undefined;
    try {
      return await evaluate(plan, settings, onProxy);
    } catch (e) {
      if (e instanceof SmartCompressError || ctx.signal?.aborted) throw e;
      unavailable.add(key);
      warnings.push(`${ctx.backend.codecName(plan.format, settings)} unavailable, skipped: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
      return undefined;
    }
  }

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    const remaining = budget - tried;
    if (remaining <= 0) break;
    if (plan.kind === "exact") {
      await tryEvaluate(plan, plan.settings);
      continue;
    }
    // Fair share of the remaining budget for this and the following search plans.
    const searchPlansLeft = plans.slice(i).filter((p) => p.kind === "search").length;
    let share = Math.max(1, Math.ceil(remaining / searchPlansLeft));
    const [lo0, hi0] = plan.range;
    if (opts.searchStrategy === "fixed") {
      await tryEvaluate(plan, { ...plan.settings, quality: plan.start });
      continue;
    }
    let lo = lo0; // highest known failing quality + 1
    let hi = hi0; // search upper bound
    let passQ: number | undefined;
    let q = plan.start;
    while (share > 0 && lo <= hi) {
      const c = await tryEvaluate(plan, { ...plan.settings, quality: q }, useProxy);
      if (!c) break;
      share--;
      const best = bestValid(useProxy ? proxyCandidates : candidates);
      if (c.report.passed) {
        passQ = q;
        hi = q - 1;
      } else {
        lo = q + 1;
        // Size grows with quality: a failing encode that is already larger than the best valid one ends this format.
        if (best && c.bytes.length >= best.bytes.length) break;
      }
      if (passQ !== undefined && passQ - lo < opts.qualityTolerance) break;
      if (passQ === undefined && q >= hi0) break;
      // Next probe: bisect the open interval; if nothing passed yet, move up towards the top of the range.
      q = passQ === undefined ? Math.min(hi, Math.ceil((lo + hi0) / 2)) : Math.floor((lo + hi) / 2);
      if (passQ === undefined && share === 0) break;
    }
  }

  if (useProxy && proxyRef) {
    // Rank formats by their smallest passing proxy encode; encode the best (and a close runner-up) at full size.
    const scale = (reference.width * reference.height) / (proxyRef.width * proxyRef.height);
    const winners = new Map<OutputFormat, Candidate>();
    for (const c of proxyCandidates) {
      const f = c.report.format as OutputFormat;
      if (c.report.passed && (!winners.get(f) || c.bytes.length < winners.get(f)!.bytes.length)) winners.set(f, c);
    }
    const ranked = [...winners.values()].sort((a, b) => a.bytes.length - b.bytes.length);
    const finalists = ranked.filter((c, i) => i === 0 || c.bytes.length <= ranked[0].bytes.length * 1.1).slice(0, 2);
    for (const fin of finalists) {
      const plan = plans.find((p) => p.kind === "search" && p.format === fin.report.format) as Extract<FormatPlan, { kind: "search" }>;
      const fullBest = bestValid();
      // Skip if the estimated full-size encode cannot beat an existing valid full-size candidate (e.g. lossless PNG).
      if (fullBest && fin.bytes.length * scale > fullBest.bytes.length * 1.15) continue;
      let q = fin.report.settings.quality as number;
      for (let attempt = 0; attempt < 3; attempt++) {
        budget++;
        const c = await tryEvaluate(plan, { ...plan.settings, quality: q });
        if (!c || c.report.passed) break;
        if (q >= plan.range[1]) break;
        q = Math.min(plan.range[1], q + Math.max(2, opts.qualityTolerance)); // tiles were not fully representative
      }
    }
  }

  // Safety net: if nothing meets the quality constraint and the original cannot be returned, add one exact encode.
  if (!bestValid()) {
    const f = (["png", "webp"] as const).find((x) => allowed.includes(x));
    if (f && pixelsExact) {
      budget++;
      await tryEvaluate(
        { kind: "exact", format: f, settings: f === "png" ? { level: 2 } : { lossless: true, quality: 75, method: 4, exact: true } },
        f === "png" ? { level: 2 } : { lossless: true, quality: 75, method: 4, exact: true },
      );
      warnings.push("No lossy candidate met minQuality within maxCandidates; a lossless encode was added");
    }
  }

  emit("finalizing", 0.97);
  return finish(undefined, category);

  // ---- Selection -------------------------------------------------------------------------------------------------
  function passthrough(bytes: Uint8Array, format: DetectedFormat): Candidate {
    const c: Candidate = {
      report: { format, codec: "original", settings: {}, bytes: bytes.length, quality: 1, qualityMetric: "exact", passed: true, durationMs: 0, note: "unmodified input" },
      bytes,
      isOriginal: true,
      container: true,
      ...display,
    };
    candidates.push(c);
    return c;
  }

  function finish(forced: Candidate | undefined, cat: ImageCategory | undefined): EngineOutput {
    const unmet: UnmetConstraint[] = [];
    let chosen = forced;
    if (!chosen) {
      const valid = candidates.filter((c) => c.report.passed).sort((a, b) => a.bytes.length - b.bytes.length);
      const fitting = opts.maxOutputBytes ? valid.filter((c) => c.bytes.length <= opts.maxOutputBytes!) : valid;
      chosen = fitting[0] ?? valid[0];
      if (!chosen) {
        // Nothing met the quality constraint: best-effort is the highest-quality candidate.
        chosen = [...candidates].sort((a, b) => (b.report.quality ?? 0) - (a.report.quality ?? 0) || a.bytes.length - b.bytes.length)[0];
        if (!chosen) throw new SmartCompressError("CODEC_UNAVAILABLE", `No encoder could produce output: ${warnings.filter((w) => w.includes("unavailable")).join("; ")}`);
        unmet.push({ constraint: "minQuality", limit: minQuality, actual: chosen.report.quality ?? 0 });
      }
      // Prefer the container candidate unless re-encoding saves at least minSavingsRatio.
      if (baseline && chosen !== baseline && chosen.bytes.length > baseline.bytes.length * (1 - opts.minSavingsRatio)) {
        if (!opts.maxOutputBytes || baseline.bytes.length <= opts.maxOutputBytes || chosen.bytes.length > opts.maxOutputBytes) {
          if (chosen.bytes.length < baseline.bytes.length) warnings.push(`Best re-encode saved less than ${Math.round(opts.minSavingsRatio * 100)}%; kept the original encoding`);
          chosen = baseline;
        }
      }
    }
    if (opts.maxOutputBytes && chosen.bytes.length > opts.maxOutputBytes) {
      unmet.push({ constraint: "maxOutputBytes", limit: opts.maxOutputBytes, actual: chosen.bytes.length });
    }
    if (explicit && chosen.report.format !== explicit) {
      unmet.push({ constraint: "targetFormat", requested: explicit, reason: "no valid candidate in the requested format" });
    }
    if (unmet.length && opts.onUnmetConstraints === "throw") {
      throw new SmartCompressError("CONSTRAINTS_UNSATISFIABLE", `Constraints not met: ${unmet.map((u) => u.constraint).join(", ")}`, { unmetConstraints: unmet });
    }
    if (flatten && chosen.container) {
      const i = warnings.findIndex((w) => w.startsWith("Animation flattened"));
      if (i >= 0) warnings.splice(i, 1);
    }
    const outFormat = chosen.report.format;
    const metadata: MetadataReport = {
      exif: !info.exif ? "none" : chosen.container ? (opts.preserveMetadata || chosen.isOriginal ? "kept" : "removed") : meta.pixel.exif ? "kept" : "removed",
      xmp: !info.xmp ? "none" : chosen.container ? (opts.preserveMetadata || chosen.isOriginal ? "kept" : "removed") : meta.pixel.xmp ? "kept" : "removed",
      iccProfile: !info.icc ? "none" : chosen.isOriginal || (meta.keepIcc && outFormat !== "avif") || (chosen.container && meta.keepIcc) ? "kept" : "dropped-srgb",
      orientation: info.orientation === 1 ? "none" : chosen.container ? "kept" : "baked",
    };
    const originalBytes = input.length;
    const outputBytes = chosen.bytes.length;
    const report: EngineReport = {
      mimeType: MIME[outFormat],
      originalBytes,
      outputBytes,
      originalFormat: info.format,
      outputFormat: outFormat,
      usedOriginal: chosen.isOriginal,
      width: chosen.width || undefined,
      height: chosen.height || undefined,
      originalWidth: display.width || undefined,
      originalHeight: display.height || undefined,
      mode: opts.mode,
      category: cat,
      durationMs: Math.round(now() - t0),
      qualityMetric: chosen.report.quality,
      qualityMetricName: chosen.report.qualityMetric,
      sizeReductionRatio: 1 - outputBytes / originalBytes,
      codec: chosen.report.codec,
      settings: chosen.report.settings,
      candidates: [...proxyCandidates, ...candidates].map((c) => c.report),
      constraintsMet: unmet.length === 0,
      unmetConstraints: unmet,
      fallbacks: [...(ctx.backend.fallbacks ?? [])],
      metadata,
      warnings,
    };
    emit("done", 1);
    return { bytes: chosen.isOriginal ? undefined : chosen.bytes, report };
  }
}
