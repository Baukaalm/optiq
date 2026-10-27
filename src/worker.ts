/// <reference lib="webworker" />
import { serializeError } from "./errors.js";
import type { CompressRequest, WorkerMessage } from "./protocol.js";
import { runJob } from "./run.js";

// One job at a time per worker; the client cancels by terminating the worker,
// which is the only way to stop a WASM encode that is already running.
const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: WorkerMessage, transfer: Transferable[] = []) => scope.postMessage(m, transfer);

scope.onmessage = async (e: MessageEvent<CompressRequest>) => {
  const req = e.data;
  if (req?.type !== "compress") return;
  try {
    const out = await runJob(req.input, req.options, req.fallback, (event) => post({ type: "progress", id: req.id, event }));
    if (out.bytes) {
      const buf = out.bytes.byteOffset === 0 && out.bytes.byteLength === out.bytes.buffer.byteLength ? out.bytes.buffer : out.bytes.slice().buffer;
      post({ type: "result", id: req.id, bytes: buf as ArrayBuffer, report: out.report }, [buf as ArrayBuffer]);
    } else post({ type: "result", id: req.id, report: out.report });
  } catch (err) {
    post({ type: "error", id: req.id, error: serializeError(err) });
  }
};
