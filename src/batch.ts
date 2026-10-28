/**
 * Batch optimisation of files in Node using a pool of worker threads (used by the CLI and the Vite plugin).
 */
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { EngineReport } from "./engine.js";
import { deserializeError, OptiqError, type SerializedError } from "./errors.js";
import type { OptiqOptions } from "./types.js";

export interface BatchItemResult {
  path: string;
  /** Output bytes; undefined when the input was already optimal (report.usedOriginal). */
  bytes?: Uint8Array;
  report?: EngineReport;
  error?: OptiqError;
}

export interface BatchOptions {
  /** Worker threads. Default: available cores − 1 (at least 1). Each holds a few copies of one decoded image. */
  concurrency?: number;
  /** `index` is the position of `r.path` in the input list. */
  onResult?: (r: BatchItemResult, done: number, total: number, index: number) => void;
  /** Aborting terminates the workers and rejects with an `ABORTED` error. */
  signal?: AbortSignal;
}

type Reply = { id: number; ok: true; bytes?: ArrayBuffer; report: EngineReport } | { id: number; ok: false; error: SerializedError };

export async function optimizeFiles(paths: string[], options: OptiqOptions, batch: BatchOptions = {}): Promise<BatchItemResult[]> {
  const n = Math.max(1, Math.min(paths.length, batch.concurrency ?? Math.max(1, availableParallelism() - 1)));
  const results: BatchItemResult[] = new Array(paths.length);
  if (!paths.length) return results;
  batch.signal?.throwIfAborted();
  let next = 0;
  let done = 0;
  await new Promise<void>((resolve, reject) => {
    const workers: Worker[] = [];
    const stop = () => {
      for (const w of workers) void w.terminate();
      batch.signal?.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      stop();
      resolve();
    };
    const onAbort = () => {
      stop();
      reject(new OptiqError("ABORTED", "Batch aborted"));
    };
    batch.signal?.addEventListener("abort", onAbort, { once: true });
    const feed = (w: Worker) => {
      if (next >= paths.length) return;
      const id = next++;
      w.postMessage({ id, path: paths[id], options });
    };
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL("./batch-worker.js", import.meta.url));
      workers.push(w);
      w.on("message", (m: Reply) => {
        const r: BatchItemResult = m.ok
          ? { path: paths[m.id], bytes: m.bytes ? new Uint8Array(m.bytes) : undefined, report: m.report }
          : { path: paths[m.id], error: deserializeError(m.error) };
        results[m.id] = r;
        done++;
        batch.onResult?.(r, done, paths.length, m.id);
        if (done === paths.length) finish();
        else feed(w);
      });
      w.on("error", (e) => {
        stop();
        reject(e);
      });
      feed(w);
    }
  });
  return results;
}
