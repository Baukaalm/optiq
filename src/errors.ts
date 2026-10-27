export type SmartCompressErrorCode =
  | "INVALID_INPUT"
  | "UNSUPPORTED_FORMAT"
  | "MALFORMED_INPUT"
  | "INPUT_TOO_LARGE"
  | "INVALID_OPTIONS"
  | "INCOMPATIBLE_OPTIONS"
  | "CONSTRAINTS_UNSATISFIABLE"
  | "CODEC_UNAVAILABLE"
  | "UNSUPPORTED_ENVIRONMENT"
  | "WORKER_ERROR"
  | "ABORTED";

export class SmartCompressError extends Error {
  readonly code: SmartCompressErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: SmartCompressErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = code === "ABORTED" ? "AbortError" : "SmartCompressError";
    this.code = code;
    this.details = details;
  }
}

export function isSmartCompressError(e: unknown): e is SmartCompressError {
  return e instanceof SmartCompressError;
}

export interface SerializedError {
  code: SmartCompressErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export function serializeError(e: unknown): SerializedError {
  if (e instanceof SmartCompressError) return { code: e.code, message: e.message, details: e.details };
  if (e instanceof Error && e.name === "AbortError") return { code: "ABORTED", message: e.message };
  // Codec exceptions carry no image content; pass the message only.
  return { code: "WORKER_ERROR", message: e instanceof Error ? e.message : String(e) };
}

export function deserializeError(s: SerializedError): SmartCompressError {
  return new SmartCompressError(s.code, s.message, s.details);
}

export function abortError(): SmartCompressError {
  return new SmartCompressError("ABORTED", "Compression was aborted");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}
