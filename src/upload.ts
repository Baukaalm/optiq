/**
 * `smartcompress/upload` — upload a compressed (or original) image to S3 through a presigned URL issued by your
 * backend. Start with {@link compressAndUpload}.
 *
 * @packageDocumentation
 */
import { compressImage, type CompressCallOptions } from "./client.js";
import { abortError, SmartCompressError } from "./errors.js";
import type { CompressionResult } from "./types.js";

/** What your backend returns for a presigned S3 upload. Credentials never reach the browser. */
export interface PresignedUpload {
  url: string;
  /** `PUT` (presigned PutObject URL, default) or `POST` (presigned POST policy with `fields`). */
  method?: "PUT" | "POST";
  /** Extra headers the signature requires (PUT). Content-Type is always sent. */
  headers?: Record<string, string>;
  /** Form fields for presigned POST. */
  fields?: Record<string, string>;
  /** Object key, echoed back in the result. */
  key?: string;
}

export interface PresignRequest {
  fileName: string;
  contentType: string;
  size: number;
  signal?: AbortSignal;
}

export type RequestPresignedUpload = (req: PresignRequest) => Promise<PresignedUpload>;

export interface UploadProgress {
  loaded: number;
  total: number;
}

export interface HttpRequest {
  method: "PUT" | "POST";
  url: string;
  headers: Record<string, string>;
  body: Blob | FormData;
  signal?: AbortSignal;
  onProgress?: (p: UploadProgress) => void;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
}

export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

export class UploadError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

/** XMLHttpRequest transport: unlike fetch, it reports upload progress in all browsers. */
export const xhrTransport: HttpTransport = (req) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(req.method, req.url);
    for (const [k, v] of Object.entries(req.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => req.onProgress?.({ loaded: e.loaded, total: e.lengthComputable ? e.total : 0 });
    xhr.onload = () => {
      const headers: Record<string, string> = {};
      for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
        const i = line.indexOf(":");
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      resolve({ status: xhr.status, headers });
    };
    xhr.onerror = () => reject(new UploadError("Network error during upload"));
    xhr.onabort = () => reject(abortError());
    if (req.signal) {
      if (req.signal.aborted) return reject(abortError());
      req.signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(req.body);
  });

export async function uploadToPresignedUrl(
  body: Blob,
  target: PresignedUpload,
  opts: { contentType: string; fileName?: string; signal?: AbortSignal; onProgress?: (p: UploadProgress) => void; transport?: HttpTransport },
): Promise<HttpResponse> {
  const transport = opts.transport ?? xhrTransport;
  const method = target.method ?? "PUT";
  let req: HttpRequest;
  if (method === "PUT") {
    req = { method, url: target.url, headers: { ...target.headers, "Content-Type": opts.contentType }, body, signal: opts.signal, onProgress: opts.onProgress };
  } else {
    const form = new FormData();
    for (const [k, v] of Object.entries(target.fields ?? {})) form.append(k, v);
    if (!target.fields?.["Content-Type"]) form.append("Content-Type", opts.contentType);
    form.append("file", body, opts.fileName); // must be the last field for S3
    req = { method, url: target.url, headers: { ...target.headers }, body: form, signal: opts.signal, onProgress: opts.onProgress };
  }
  const res = await transport(req);
  if (res.status < 200 || res.status >= 300) throw new UploadError(`Upload failed with HTTP ${res.status}`, res.status);
  return res;
}

export interface CompressAndUploadOptions {
  requestPresignedUpload: RequestPresignedUpload;
  /** SmartCompress options, or `false` to upload the original as-is. */
  compression?: Omit<CompressCallOptions, "signal" | "onProgress"> | false;
  /** Custom compressor (defaults to the shared `compressImage`). */
  compress?: (input: Blob, options: CompressCallOptions) => Promise<CompressionResult>;
  signal?: AbortSignal;
  onStage?: (stage: "compressing" | "presigning" | "uploading" | "done") => void;
  onCompressProgress?: CompressCallOptions["onProgress"];
  onUploadProgress?: (p: UploadProgress) => void;
  transport?: HttpTransport;
}

export interface CompressAndUploadResult {
  /** Which bytes were uploaded. */
  uploaded: "optimized" | "original";
  key?: string;
  fileName: string;
  contentType: string;
  bytes: number;
  compression?: CompressionResult;
  /** Set when compression failed and the original was uploaded instead. */
  compressionError?: SmartCompressError;
}

/**
 * Compress (optional, never required) then upload through a presigned URL from your backend.
 * If compression fails or does not help, the original file is uploaded unchanged. Upload errors are thrown;
 * the caller still holds the original `file` and can retry.
 */
export async function compressAndUpload(file: File, opts: CompressAndUploadOptions): Promise<CompressAndUploadResult> {
  const compress = opts.compress ?? compressImage;
  let compression: CompressionResult | undefined;
  let compressionError: SmartCompressError | undefined;
  if (opts.compression !== false) {
    opts.onStage?.("compressing");
    try {
      compression = await compress(file, { ...opts.compression, signal: opts.signal, onProgress: opts.onCompressProgress });
    } catch (e) {
      if (e instanceof SmartCompressError && e.code === "ABORTED") throw e;
      if (opts.signal?.aborted) throw abortError();
      compressionError = e instanceof SmartCompressError ? e : new SmartCompressError("WORKER_ERROR", e instanceof Error ? e.message : String(e));
    }
  }
  const useOptimized = !!compression && !compression.usedOriginal && compression.outputBytes < file.size;
  const body: Blob = useOptimized ? compression!.blob : compression?.usedOriginal ? compression.blob : file;
  const fileName = compression ? compression.fileName : file.name;
  const contentType = compression ? compression.mimeType : file.type || "application/octet-stream";
  opts.onStage?.("presigning");
  const target = await opts.requestPresignedUpload({ fileName, contentType, size: body.size, signal: opts.signal });
  opts.onStage?.("uploading");
  await uploadToPresignedUrl(body, target, { contentType, fileName, signal: opts.signal, onProgress: opts.onUploadProgress, transport: opts.transport });
  opts.onStage?.("done");
  return { uploaded: useOptimized ? "optimized" : "original", key: target.key, fileName, contentType, bytes: body.size, compression, compressionError };
}
