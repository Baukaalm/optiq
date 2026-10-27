import type { EncodeSettings } from "./codecs/types.js";
import type { ResolvedOptions } from "./options.js";
import type { ImageCategory, OutputFormat } from "./types.js";

/** One codec configuration to try. `search` plans get a quality search; `exact` plans are encoded once and verified. */
export type FormatPlan =
  | { kind: "exact"; format: OutputFormat; settings: EncodeSettings; /** oxipng on the original PNG bytes */ fromContainer?: boolean }
  | { kind: "search"; format: OutputFormat; settings: EncodeSettings; range: [number, number]; start: number };

export interface PlanInput {
  category: ImageCategory;
  allowed: OutputFormat[];
  transparent: boolean;
  /** PNG input whose container can be re-optimised directly (no resize/flatten/orientation change). */
  pngContainerEligible: boolean;
  /** Decoded pixels exactly represent the source (8-bit). */
  pixelsExact: boolean;
  /** Input was lossy-coded (JPEG, lossy WebP, AVIF): lossless re-encodes of its pixels are almost always larger. */
  inputLossy: boolean;
}

// Upper bounds were 95/95/92 until the audit found photos (P3 PNG) that need JPEG/WebP q96+ to reach SSIM 0.99.
const RANGES: Record<Exclude<OutputFormat, "png">, [number, number]> = {
  jpeg: [40, 98],
  webp: [40, 99],
  avif: [25, 95],
};

/** Starting points for the search, by mode. Chosen from benchmark medians; only affect speed, not the result's validity. */
const START: Record<"visually-lossless" | "balanced" | "fast", Record<Exclude<OutputFormat, "png">, number>> = {
  "visually-lossless": { jpeg: 86, webp: 86, avif: 72 },
  balanced: { jpeg: 76, webp: 76, avif: 58 },
  fast: { jpeg: 78, webp: 78, avif: 58 },
};

const isGraphic = (c: ImageCategory) => c === "screenshot" || c === "text-graphic" || c === "illustration" || c === "transparent-illustration";

export function losslessPlans(input: PlanInput, mode: ResolvedOptions["mode"]): FormatPlan[] {
  const plans: FormatPlan[] = [];
  const has = (f: OutputFormat) => input.allowed.includes(f);
  // oxipng costs ~0.3 s per MP and rarely beats lossless WebP on graphics; `fast` only uses it when PNG is required.
  if (has("png") && !(mode === "fast" && has("webp"))) {
    if (input.pngContainerEligible) plans.push({ kind: "exact", format: "png", settings: { level: 2 }, fromContainer: true });
    else if (input.pixelsExact) plans.push({ kind: "exact", format: "png", settings: { level: 2 } });
  }
  if (has("webp") && input.pixelsExact) {
    plans.push({ kind: "exact", format: "webp", settings: { lossless: true, quality: 75, method: mode === "lossless" ? 5 : 4, exact: true } });
  }
  return plans;
}

/**
 * Order matters: candidates that tend to win for the category run first so that later formats can stop early
 * (a failing encode that is already larger than the best valid candidate ends that format's search).
 */
export function planCandidates(input: PlanInput, opts: ResolvedOptions): FormatPlan[] {
  if (opts.mode === "lossless") {
    // Lossless re-encoding of decoded lossy photos costs seconds and loses to the container-level candidate.
    if (input.inputLossy && input.category === "photo") return [];
    return losslessPlans(input, opts.mode);
  }
  const mode = opts.mode;
  const has = (f: OutputFormat) => input.allowed.includes(f);
  const start = START[mode];
  const search = (format: Exclude<OutputFormat, "png">, settings: EncodeSettings): FormatPlan => ({
    kind: "search",
    format,
    settings,
    range: RANGES[format],
    start: start[format],
  });
  const plans: FormatPlan[] = [];
  const graphic = isGraphic(input.category);
  // Lossless encodes are only worth their cost for flat-colour content, or when nothing else is allowed.
  const lossyAllowed = has("jpeg") || has("webp") || has("avif");
  if (graphic || input.category === "gradient" || !lossyAllowed) plans.push(...losslessPlans(input, mode));
  const chroma = graphic ? "444" : "420";
  const lossy: FormatPlan[] = [];
  if (has("avif")) lossy.push(search("avif", input.transparent ? { speed: opts.avifSpeed, chroma, alphaBoost: 25 } : { speed: opts.avifSpeed, chroma }));
  if (has("webp")) lossy.push(search("webp", { method: 4, sharpYuv: graphic }));
  if (has("jpeg") && !input.transparent) lossy.push(search("jpeg", { chroma }));
  // For graphics WebP usually beats AVIF at high SSIM targets and is much faster; try it first.
  if (graphic) lossy.sort((a, b) => (a.format === "webp" ? -1 : b.format === "webp" ? 1 : 0));
  plans.push(...lossy);
  return plans;
}

/** Gradients band visibly before SSIM drops; require a stricter threshold for them. */
export function effectiveMinQuality(category: ImageCategory, opts: ResolvedOptions): number {
  if (opts.mode === "lossless") return 1;
  if (category === "gradient") return opts.minQuality + (1 - opts.minQuality) / 2;
  return opts.minQuality;
}
