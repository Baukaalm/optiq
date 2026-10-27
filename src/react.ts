/**
 * `optiq-image/react` — React hook around {@link compressImage}. Requires React 18+ (optional peer dependency).
 *
 * @packageDocumentation
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { compressImage, type CompressCallOptions, type Compressor } from "./client.js";
import type { CompressionResult, ProgressEvent } from "./types.js";

export type UseOptiqStatus = "idle" | "compressing" | "done" | "error" | "cancelled";

export interface UseOptiqOptions extends Omit<CompressCallOptions, "signal" | "onProgress"> {
  /** Use a specific compressor (worker pool) instead of the shared one. */
  compressor?: Compressor;
  /** Set to false to keep the hook idle. Default true. */
  enabled?: boolean;
}

export interface UseOptiqState {
  status: UseOptiqStatus;
  result?: CompressionResult;
  /** The thrown value; usually an OptiqError with a `code`. The original file is always still usable. */
  error?: unknown;
  progress?: ProgressEvent;
  /** Abort the running compression (terminates its worker). */
  cancel: () => void;
}

/**
 * Compress `file` whenever it (or the options) change. Cancels the previous run automatically, and on unmount.
 *
 * ```tsx
 * const { status, result, progress, cancel } = useOptiq(file, { mode: "balanced" });
 * ```
 */
export function useOptiq(file: Blob | null | undefined, options: UseOptiqOptions = {}): UseOptiqState {
  const { compressor, enabled = true, ...compressOptions } = options;
  const [state, setState] = useState<Omit<UseOptiqState, "cancel">>({ status: "idle" });
  const controller = useRef<AbortController | undefined>(undefined);
  // Options are compared by value so inline objects do not restart the job on every render.
  const key = JSON.stringify(compressOptions);

  useEffect(() => {
    if (!file || !enabled) {
      setState({ status: "idle" });
      return;
    }
    const ac = new AbortController();
    controller.current = ac;
    setState({ status: "compressing" });
    const run = compressor ? compressor.compress.bind(compressor) : compressImage;
    run(file, { ...(JSON.parse(key) as CompressCallOptions), signal: ac.signal, onProgress: (progress) => !ac.signal.aborted && setState({ status: "compressing", progress }) }).then(
      (result) => !ac.signal.aborted && setState({ status: "done", result }),
      (error) => setState(ac.signal.aborted ? { status: "cancelled" } : { status: "error", error }),
    );
    return () => ac.abort();
  }, [file, enabled, key, compressor]);

  const cancel = useCallback(() => controller.current?.abort(), []);
  return { ...state, cancel };
}
