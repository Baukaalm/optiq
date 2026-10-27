import type { EngineReport } from "./engine.js";
import type { SerializedError } from "./errors.js";
import type { ProgressEvent, SmartCompressOptions } from "./types.js";

export type CodecFallbackPolicy = "canvas" | "none";

export interface CompressRequest {
  type: "compress";
  id: number;
  /** Blobs are structured-cloned by reference, so the main thread never copies the file. */
  input: Blob;
  options?: SmartCompressOptions;
  fallback: CodecFallbackPolicy;
}

export type WorkerMessage =
  | { type: "progress"; id: number; event: ProgressEvent }
  | { type: "result"; id: number; bytes?: ArrayBuffer; report: EngineReport }
  | { type: "error"; id: number; error: SerializedError };
