import { OptiqError } from "./errors.js";
import type { CompressionMode, OutputFormat, SearchStrategy, OptiqOptions, TargetFormat } from "./types.js";

export interface ResolvedOptions {
  mode: CompressionMode;
  maxOutputBytes?: number;
  maxWidthOrHeight?: number;
  allowLossyResize: boolean;
  targetFormat: TargetFormat;
  autoFormats: OutputFormat[];
  minQuality: number;
  maxCandidates: number;
  searchStrategy: SearchStrategy;
  preserveMetadata: boolean;
  preserveAnimation: boolean;
  allowFormatConversion: boolean;
  minSavingsRatio: number;
  maxInputBytes: number;
  maxInputPixels: number;
  onUnmetConstraints: "best-effort" | "throw";
  /** Quality search tolerance (codec quality units). */
  qualityTolerance: number;
  avifSpeed: number;
}

export const OUTPUT_FORMATS: readonly OutputFormat[] = ["jpeg", "png", "webp", "avif"];
const TARGETS: readonly TargetFormat[] = ["auto", "original", ...OUTPUT_FORMATS];
const MODES: readonly CompressionMode[] = ["lossless", "visually-lossless", "balanced", "fast"];

export const MODE_DEFAULTS: Record<CompressionMode, { minQuality: number; maxCandidates: number; qualityTolerance: number; avifSpeed: number }> = {
  lossless: { minQuality: 1, maxCandidates: 4, qualityTolerance: 0, avifSpeed: 6 },
  "visually-lossless": { minQuality: 0.99, maxCandidates: 16, qualityTolerance: 3, avifSpeed: 6 },
  // AVIF speed 7, not 8: at speed 8 libaom lost its screen-content gains (5 MP dashboard: 45 KB vs 13 KB at q50).
  balanced: { minQuality: 0.975, maxCandidates: 10, qualityTolerance: 5, avifSpeed: 7 },
  // Same quality bar as balanced; cost is capped instead: AVIF (3.5 MB download, slowest encoder, most memory) is off
  // by default, oxipng is skipped, and the quality search stops early.
  fast: { minQuality: 0.975, maxCandidates: 5, qualityTolerance: 8, avifSpeed: 8 },
};

function invalid(message: string): never {
  throw new OptiqError("INVALID_OPTIONS", message);
}

function positiveInt(name: string, v: number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isFinite(v) || v <= 0 || Math.floor(v) !== v) invalid(`${name} must be a positive integer`);
  return v;
}

export function resolveOptions(o: OptiqOptions = {}): ResolvedOptions {
  const mode = o.mode ?? "balanced";
  if (!MODES.includes(mode)) invalid(`mode must be one of ${MODES.join(", ")}; got "${String(mode)}"`);
  const d = MODE_DEFAULTS[mode];
  const targetFormat = o.targetFormat ?? "auto";
  if (!TARGETS.includes(targetFormat)) invalid(`targetFormat must be one of ${TARGETS.join(", ")}; got "${String(targetFormat)}"`);
  const autoFormats = o.autoFormats ?? (mode === "fast" ? OUTPUT_FORMATS.filter((f) => f !== "avif") : [...OUTPUT_FORMATS]);
  if (!autoFormats.length || autoFormats.some((f) => !OUTPUT_FORMATS.includes(f))) invalid(`autoFormats must be a non-empty subset of ${OUTPUT_FORMATS.join(", ")}`);
  if (o.minQuality !== undefined && (!Number.isFinite(o.minQuality) || o.minQuality <= 0 || o.minQuality > 1)) {
    invalid("minQuality is an SSIM value and must be in (0, 1]");
  }
  if (o.minSavingsRatio !== undefined && (!Number.isFinite(o.minSavingsRatio) || o.minSavingsRatio < 0 || o.minSavingsRatio >= 1)) {
    invalid("minSavingsRatio must be in [0, 1)");
  }
  if (o.searchStrategy !== undefined && o.searchStrategy !== "binary" && o.searchStrategy !== "fixed") invalid('searchStrategy must be "binary" or "fixed"');
  if (o.onUnmetConstraints !== undefined && o.onUnmetConstraints !== "best-effort" && o.onUnmetConstraints !== "throw") {
    invalid('onUnmetConstraints must be "best-effort" or "throw"');
  }
  // A conflict between allowFormatConversion:false and an explicit targetFormat is resolved against the input format later.
  const allowFormatConversion = o.allowFormatConversion ?? true;
  const maxCandidates = positiveInt("maxCandidates", o.maxCandidates) ?? d.maxCandidates;
  if (maxCandidates > 64) invalid("maxCandidates must be <= 64");
  return {
    mode,
    maxOutputBytes: positiveInt("maxOutputBytes", o.maxOutputBytes),
    maxWidthOrHeight: positiveInt("maxWidthOrHeight", o.maxWidthOrHeight),
    allowLossyResize: o.allowLossyResize ?? false,
    targetFormat,
    autoFormats,
    minQuality: mode === "lossless" ? 1 : (o.minQuality ?? d.minQuality),
    maxCandidates,
    searchStrategy: o.searchStrategy ?? "binary",
    preserveMetadata: o.preserveMetadata ?? true,
    preserveAnimation: o.preserveAnimation ?? true,
    allowFormatConversion,
    minSavingsRatio: o.minSavingsRatio ?? 0.02,
    maxInputBytes: positiveInt("maxInputBytes", o.maxInputBytes) ?? 100 * 1024 * 1024,
    maxInputPixels: positiveInt("maxInputPixels", o.maxInputPixels) ?? 50_000_000,
    onUnmetConstraints: o.onUnmetConstraints ?? "best-effort",
    qualityTolerance: d.qualityTolerance,
    avifSpeed: d.avifSpeed,
  };
}
