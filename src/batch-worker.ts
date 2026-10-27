// worker_threads entry for batch optimisation in Node (CLI, Vite plugin). One image at a time per thread:
// the WASM codecs are single-threaded, so parallelism comes from running several of these.
import { readFile } from "node:fs/promises";
import { parentPort } from "node:worker_threads";
import { serializeError } from "./errors.js";
import { optimizeInNode } from "./node.js";
import type { OptiqOptions } from "./types.js";

export interface BatchRequest {
  id: number;
  path: string;
  options: OptiqOptions;
}

parentPort!.on("message", async (req: BatchRequest) => {
  try {
    const input = new Uint8Array(await readFile(req.path));
    const out = await optimizeInNode(input, req.options);
    const bytes = out.bytes ? out.bytes.slice().buffer : undefined;
    parentPort!.postMessage({ id: req.id, ok: true, bytes, report: out.report }, bytes ? [bytes] : []);
  } catch (e) {
    parentPort!.postMessage({ id: req.id, ok: false, error: serializeError(e) });
  }
});
