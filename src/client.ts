import type { EngineReport } from "./engine.js";
import { abortError, deserializeError, SmartCompressError } from "./errors.js";
import type { CodecFallbackPolicy, CompressRequest, WorkerMessage } from "./protocol.js";
import type { CompressionResult, OutputFormat, DetectedFormat, ProgressEvent, SmartCompressOptions } from "./types.js";

export interface CompressCallOptions extends SmartCompressOptions {
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
}

export interface CompressorConfig {
  /** Concurrent jobs (= worker count). Default: min(2, max(1, hardwareConcurrency - 1)). Each job holds a few copies of the decoded image. */
  maxWorkers?: number;
  /** Custom worker construction (e.g. a bundler-specific `?worker` import, or a CDN URL). */
  workerFactory?: () => Worker;
  /** Terminate workers idle for this long. Default 30 s. */
  idleTimeoutMs?: number;
  /**
   * Codec fallback when a WASM codec cannot load: `canvas` (default) uses the browser's own encoders via
   * OffscreenCanvas and reports it in `result.fallbacks`; `none` fails with an error instead.
   */
  codecFallback?: CodecFallbackPolicy;
  /** Run on the main thread when Workers are unavailable. Default false (throws UNSUPPORTED_ENVIRONMENT): this blocks the UI. */
  allowMainThread?: boolean;
  /**
   * Terminate the worker after a job whose image had more pixels than this. WebAssembly memory never shrinks, so
   * this is how the codec heaps grown by a large image are returned to the system. Default 8 MP.
   */
  recycleAfterPixels?: number;
}

export interface Compressor {
  compress(input: Blob, options?: CompressCallOptions): Promise<CompressionResult>;
  /** Terminate all workers and reject queued/running jobs. */
  terminate(): void;
}

const EXT: Record<OutputFormat | DetectedFormat, string> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
  avif: "avif",
  gif: "gif",
  heif: "heic",
  svg: "svg",
};

/** Replace the extension of `name` with the one matching `format`. */
export function fileNameFor(name: string | undefined, format: OutputFormat | DetectedFormat): string {
  const base = (name ?? "").replace(/[\\/]/g, "_").replace(/\.[^.]*$/, "") || "image";
  return `${base}.${EXT[format]}`;
}

/** Wrap a result as a File with a name, type and extension that match the encoded bytes. */
export function toFile(result: CompressionResult, lastModified?: number): File {
  return new File([result.blob], result.fileName, { type: result.mimeType, lastModified });
}

export function buildResult(input: Blob, bytes: ArrayBuffer | Uint8Array | undefined, report: EngineReport): CompressionResult {
  // For "original" results, re-label (without copying) so a wrong client-side MIME type is not propagated.
  const blob = bytes ? new Blob([bytes as BlobPart], { type: report.mimeType }) : input.type === report.mimeType ? input : input.slice(0, input.size, report.mimeType);
  return { ...report, blob, fileName: fileNameFor((input as File).name, report.outputFormat) };
}

function defaultWorkerFactory(): Worker {
  return new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "smartcompress" });
}

interface Job {
  id: number;
  input: Blob;
  options: SmartCompressOptions;
  onProgress?: (e: ProgressEvent) => void;
  signal?: AbortSignal;
  resolve: (r: CompressionResult) => void;
  reject: (e: unknown) => void;
  slot?: Slot;
  cleanup: () => void;
}

interface Slot {
  worker: Worker;
  job?: Job;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export function createCompressor(config: CompressorConfig = {}): Compressor {
  const hc = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  const maxWorkers = Math.max(1, config.maxWorkers ?? Math.min(2, Math.max(1, hc - 1)));
  const idleTimeoutMs = config.idleTimeoutMs ?? 30_000;
  const fallback = config.codecFallback ?? "canvas";
  const factory = config.workerFactory ?? defaultWorkerFactory;
  const recycleAfterPixels = config.recycleAfterPixels ?? 8_000_000;
  const slots: Slot[] = [];
  const queue: Job[] = [];
  let nextId = 1;
  let terminated = false;

  function retire(slot: Slot) {
    clearTimeout(slot.idleTimer);
    slot.worker.terminate();
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
  }

  function settle(job: Job, recycle = false) {
    job.cleanup();
    if (job.slot) {
      const slot = job.slot;
      slot.job = undefined;
      job.slot = undefined;
      if (recycle) retire(slot);
      else slot.idleTimer = setTimeout(() => retire(slot), idleTimeoutMs);
    }
    pump();
  }

  function onMessage(slot: Slot, e: MessageEvent<WorkerMessage>) {
    const job = slot.job;
    const m = e.data;
    if (!job || m.id !== job.id) return;
    if (m.type === "progress") job.onProgress?.(m.event);
    else if (m.type === "result") {
      settle(job, (m.report.originalWidth ?? 0) * (m.report.originalHeight ?? 0) > recycleAfterPixels);
      job.resolve(buildResult(job.input, m.bytes, m.report));
    } else {
      settle(job);
      job.reject(deserializeError(m.error));
    }
  }

  function onCrash(slot: Slot, detail: string) {
    const job = slot.job;
    retire(slot);
    if (job) {
      job.slot = undefined;
      job.cleanup();
      job.reject(new SmartCompressError("WORKER_ERROR", `Compression worker failed: ${detail}`));
    }
    pump();
  }

  function spawn(): Slot {
    const worker = factory();
    const slot: Slot = { worker };
    worker.onmessage = (e) => onMessage(slot, e);
    worker.onerror = (e) => {
      e.preventDefault?.();
      onCrash(slot, e.message || "worker script error (could not load or uncaught exception)");
    };
    worker.onmessageerror = () => onCrash(slot, "message could not be deserialized");
    slots.push(slot);
    return slot;
  }

  function pump() {
    while (queue.length) {
      let slot = slots.find((s) => !s.job);
      if (!slot) {
        if (slots.length >= maxWorkers) return;
        try {
          slot = spawn();
        } catch (e) {
          const job = queue.shift()!;
          job.cleanup();
          job.reject(new SmartCompressError("UNSUPPORTED_ENVIRONMENT", `Could not start a Web Worker: ${e instanceof Error ? e.message : String(e)}`));
          continue;
        }
      }
      const job = queue.shift()!;
      clearTimeout(slot.idleTimer);
      slot.job = job;
      job.slot = slot;
      const req: CompressRequest = { type: "compress", id: job.id, input: job.input, options: job.options, fallback };
      slot.worker.postMessage(req);
    }
  }

  async function runOnMainThread(input: Blob, options: CompressCallOptions): Promise<CompressionResult> {
    const { runJob } = await import("./run.js");
    const { signal, onProgress, ...rest } = options;
    const out = await runJob(input, rest, fallback, onProgress, signal);
    out.report.fallbacks.push("main-thread: Web Workers unavailable, ran on the main thread");
    return buildResult(input, out.bytes, out.report);
  }

  return {
    compress(input: Blob, options: CompressCallOptions = {}) {
      if (terminated) return Promise.reject(new SmartCompressError("UNSUPPORTED_ENVIRONMENT", "Compressor was terminated"));
      if (!(input instanceof Blob)) return Promise.reject(new SmartCompressError("INVALID_INPUT", "Input must be a File or Blob"));
      const { signal, onProgress, ...engineOptions } = options;
      if (signal?.aborted) return Promise.reject(abortError());
      const limit = engineOptions.maxInputBytes ?? 100 * 1024 * 1024;
      if (input.size > limit) {
        return Promise.reject(new SmartCompressError("INPUT_TOO_LARGE", `Input is ${input.size} bytes; limit is ${limit} (maxInputBytes)`, { bytes: input.size, limit }));
      }
      if (typeof Worker === "undefined" && !config.workerFactory) {
        if (config.allowMainThread) return runOnMainThread(input, options);
        return Promise.reject(new SmartCompressError("UNSUPPORTED_ENVIRONMENT", "Web Workers are not available; pass allowMainThread: true to run on the main thread"));
      }
      return new Promise<CompressionResult>((resolve, reject) => {
        const job: Job = { id: nextId++, input, options: engineOptions, onProgress, signal, resolve, reject, cleanup: () => {} };
        if (signal) {
          const onAbort = () => {
            const qi = queue.indexOf(job);
            if (qi >= 0) queue.splice(qi, 1);
            if (job.slot) {
              // A running WASM encode cannot be interrupted: drop the worker.
              const slot = job.slot;
              job.slot = undefined;
              retire(slot);
            }
            job.cleanup();
            reject(abortError());
            pump();
          };
          signal.addEventListener("abort", onAbort, { once: true });
          job.cleanup = () => signal.removeEventListener("abort", onAbort);
        }
        queue.push(job);
        pump();
      });
    },
    terminate() {
      terminated = true;
      for (const job of queue.splice(0)) {
        job.cleanup();
        job.reject(abortError());
      }
      for (const slot of [...slots]) {
        const job = slot.job;
        retire(slot);
        if (job) {
          job.cleanup();
          job.reject(abortError());
        }
      }
    },
  };
}

let shared: Compressor | undefined;

/**
 * Compress an image in a background Web Worker using a shared compressor.
 * Rejects with `SmartCompressError` (`code`), or an `AbortError` (code `ABORTED`) when `signal` aborts.
 */
export function compressImage(input: File | Blob, options?: CompressCallOptions): Promise<CompressionResult> {
  shared ??= createCompressor();
  return shared.compress(input, options);
}
