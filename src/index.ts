/**
 * `smartcompress` — compress images in a Web Worker and get the smallest output that meets a lossless or
 * perceptual (SSIM) constraint. Start with {@link compressImage}.
 *
 * @packageDocumentation
 */
export { compressImage, createCompressor, toFile, fileNameFor } from "./client.js";
export type { CompressCallOptions, Compressor, CompressorConfig } from "./client.js";
export type { CodecFallbackPolicy } from "./protocol.js";
export { SmartCompressError, isSmartCompressError } from "./errors.js";
export type { SmartCompressErrorCode } from "./errors.js";
export { sniffFormat } from "./probe.js";
export type {
  CandidateReport,
  CompressionMode,
  CompressionResult,
  DecodableFormat,
  DetectedFormat,
  ImageCategory,
  MetadataReport,
  OutputFormat,
  ProgressEvent,
  ProgressStage,
  QualityMetricName,
  SearchStrategy,
  SmartCompressOptions,
  TargetFormat,
  UnmetConstraint,
} from "./types.js";
