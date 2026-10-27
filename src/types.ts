/** Formats Optiq can recognise from magic bytes. Recognition is not the same as support. */
export type DetectedFormat = "jpeg" | "png" | "webp" | "avif" | "gif" | "heif" | "svg";

/** Formats that can be decoded to pixels and re-encoded. */
export type DecodableFormat = "jpeg" | "png" | "webp" | "avif" | "gif";

/** Formats Optiq can encode. */
export type OutputFormat = "jpeg" | "png" | "webp" | "avif";

export type TargetFormat = "auto" | "original" | OutputFormat;

/**
 * - `lossless`: decoded pixels (incl. alpha) of the output are verified to be identical to the input.
 * - `visually-lossless`: decoded pixels may differ; the perceptual difference (SSIM) is kept above a strict threshold.
 * - `balanced`: lower SSIM threshold and smaller search budget; trades some quality for size and speed.
 */
export type CompressionMode = "lossless" | "visually-lossless" | "balanced";

export type ImageCategory =
  | "photo"
  | "screenshot"
  | "text-graphic"
  | "illustration"
  | "transparent-illustration"
  | "gradient";

export type SearchStrategy = "binary" | "fixed";

export interface OptiqOptions {
  /** Default `balanced`. */
  mode?: CompressionMode;
  /** Upper bound for output size. Not a promise: reported in `unmetConstraints` if impossible. */
  maxOutputBytes?: number;
  /** Downscale so that the longest side is at most this. Never applied in `lossless` mode unless `allowLossyResize`. */
  maxWidthOrHeight?: number;
  /** Explicitly permit resizing in `lossless` mode (the result is then no longer pixel-identical to the input). */
  allowLossyResize?: boolean;
  /** Default `auto`. */
  targetFormat?: TargetFormat;
  /**
   * Formats considered when `targetFormat` is `auto`. Default: jpeg, png, webp, avif.
   * Remove `avif` if your audience includes browsers without AVIF decoding or encode time matters most.
   */
  autoFormats?: OutputFormat[];
  /** Minimum SSIM (0..1) for perceptual modes. Defaults: visually-lossless 0.99, balanced 0.975. Ignored in lossless mode. */
  minQuality?: number;
  /** Maximum number of encodes (candidates) per image. Defaults: visually-lossless 18, balanced 10, lossless 4. */
  maxCandidates?: number;
  /** `binary` (default) searches quality per codec; `fixed` encodes each codec once at a preset quality. */
  searchStrategy?: SearchStrategy;
  /** Keep EXIF/XMP and non-sRGB/sRGB ICC profiles. Default `true`. Setting `false` strips them (privacy: removes GPS etc). */
  preserveMetadata?: boolean;
  /** Default `true`. When `false`, animated inputs may be flattened to their first frame (with a warning). */
  preserveAnimation?: boolean;
  /** Default `true` when `targetFormat` is `auto`. When `false`, the output keeps the input format. */
  allowFormatConversion?: boolean;
  /** Return the original when the best candidate saves less than this fraction. Default 0.02. */
  minSavingsRatio?: number;
  /** Reject inputs larger than this many bytes before reading them. Default 100 MiB. */
  maxInputBytes?: number;
  /** Reject inputs whose header declares more pixels than this (decompression-bomb guard). Default 50 MP. */
  maxInputPixels?: number;
  /** What to do when no candidate meets all constraints. Default `best-effort` (result lists `unmetConstraints`). */
  onUnmetConstraints?: "best-effort" | "throw";
}

export type ProgressStage =
  | "reading"
  | "probing"
  | "decoding"
  | "analyzing"
  | "resizing"
  | "encoding"
  | "finalizing"
  | "done";

export interface ProgressEvent {
  stage: ProgressStage;
  /** Rough overall progress 0..1. */
  progress: number;
  /** Encodes done so far / allowed budget. */
  candidatesTried: number;
  candidateBudget: number;
  /** Smallest valid candidate so far, in bytes. */
  bestBytes?: number;
}

export interface CandidateReport {
  format: OutputFormat | DetectedFormat;
  codec: string;
  settings: Record<string, number | boolean | string>;
  bytes: number;
  /** SSIM for perceptual candidates, 1 for verified-exact candidates. Undefined if not evaluated. */
  quality?: number;
  qualityMetric?: QualityMetricName;
  /** Satisfies the quality constraint (and is exact, for lossless). */
  passed: boolean;
  durationMs: number;
  /** Encoded from the tile mosaic used for quality search on large images; never selected as output. */
  proxy?: boolean;
  note?: string;
}

export type QualityMetricName = "exact" | "ssim";

export type UnmetConstraint =
  | { constraint: "maxOutputBytes"; limit: number; actual: number }
  | { constraint: "minQuality"; limit: number; actual: number }
  | { constraint: "targetFormat"; requested: string; reason: string };

export interface MetadataReport {
  exif: "kept" | "removed" | "none" | "unsupported-in-output";
  xmp: "kept" | "removed" | "none" | "unsupported-in-output";
  iccProfile: "kept" | "dropped-srgb" | "none";
  /** `baked`: pixels were rotated/flipped and the orientation tag reset to 1. */
  orientation: "kept" | "baked" | "none";
}

export interface CompressionResult {
  blob: Blob;
  /** Suggested file name with the extension matching `outputFormat`. */
  fileName: string;
  mimeType: string;
  originalBytes: number;
  outputBytes: number;
  originalFormat: DetectedFormat;
  outputFormat: OutputFormat | DetectedFormat;
  /** True when `blob` is the unmodified input. */
  usedOriginal: boolean;
  /** Dimensions of the output as displayed (after orientation). */
  width?: number;
  height?: number;
  originalWidth?: number;
  originalHeight?: number;
  mode: CompressionMode;
  category?: ImageCategory;
  durationMs: number;
  /** Quality of the chosen output vs. the reference (input, or resized input). */
  qualityMetric?: number;
  qualityMetricName?: QualityMetricName;
  /** 1 - outputBytes/originalBytes (negative if larger). */
  sizeReductionRatio: number;
  codec?: string;
  settings?: Record<string, number | boolean | string>;
  candidates: CandidateReport[];
  constraintsMet: boolean;
  unmetConstraints: UnmetConstraint[];
  /** Codec/runtime fallbacks used (e.g. canvas encoder instead of WASM). Empty when none. */
  fallbacks: string[];
  metadata: MetadataReport;
  warnings: string[];
}
