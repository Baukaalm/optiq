export type OptiqErrorCode =
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

export class OptiqError extends Error {
  readonly code: OptiqErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: OptiqErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = code === "ABORTED" ? "AbortError" : "OptiqError";
    this.code = code;
    this.details = details;
  }
}

export function isOptiqError(e: unknown): e is OptiqError {
  return e instanceof OptiqError;
}

export interface SerializedError {
  code: OptiqErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export function serializeError(e: unknown): SerializedError {
  if (e instanceof OptiqError) return { code: e.code, message: e.message, details: e.details };
  if (e instanceof Error && e.name === "AbortError") return { code: "ABORTED", message: e.message };
  // Codec exceptions carry no image content; pass the message only.
  return { code: "WORKER_ERROR", message: e instanceof Error ? e.message : String(e) };
}

export function deserializeError(s: SerializedError): OptiqError {
  return new OptiqError(s.code, s.message, s.details);
}

export function abortError(): OptiqError {
  return new OptiqError("ABORTED", "Compression was aborted");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}
