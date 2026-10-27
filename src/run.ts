import { canvasBackendAvailable, createCanvasBackend } from "./codecs/canvas.js";
import { withFallback } from "./codecs/fallback.js";
import { createWasmBackend } from "./codecs/wasm.js";
import { optimize, type EngineOutput } from "./engine.js";
import type { CodecFallbackPolicy } from "./protocol.js";
import type { ProgressEvent, OptiqOptions } from "./types.js";

/** Run the engine with the default browser backend (WASM codecs, optional canvas fallback). */
export async function runJob(
  input: Blob,
  options: OptiqOptions | undefined,
  fallback: CodecFallbackPolicy,
  onProgress?: (e: ProgressEvent) => void,
  signal?: AbortSignal,
): Promise<EngineOutput> {
  onProgress?.({ stage: "reading", progress: 0, candidatesTried: 0, candidateBudget: 0 });
  const bytes = new Uint8Array(await input.arrayBuffer());
  const secondary = fallback === "canvas" && canvasBackendAvailable() ? createCanvasBackend() : undefined;
  return optimize(bytes, options, { backend: withFallback(createWasmBackend(), secondary), onProgress, signal });
}
