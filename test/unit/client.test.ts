import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildResult, createCompressor, fileNameFor } from "../../src/client.js";
import { createWasmBackend } from "../../src/codecs/wasm.js";
import { optimize } from "../../src/engine.js";
import { serializeError } from "../../src/errors.js";
import { initNodeCodecs } from "../../src/node.js";
import type { CompressRequest, WorkerMessage } from "../../src/protocol.js";
import { photoLike, toJpeg, toPng, screenshotLike } from "../helpers/fixtures.js";

beforeAll(() => initNodeCodecs());

/** In-process stand-in for a Worker that runs the real engine. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<WorkerMessage>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  constructor(public mode: "ok" | "crash" | "hang" = "ok") {
    FakeWorker.instances.push(this);
  }
  postMessage(req: CompressRequest) {
    if (this.mode === "crash") {
      queueMicrotask(() => this.onerror?.({ message: "boom", preventDefault() {} } as ErrorEvent));
      return;
    }
    if (this.mode === "hang") return;
    (async () => {
      const send = (m: WorkerMessage) => !this.terminated && this.onmessage?.({ data: m } as MessageEvent<WorkerMessage>);
      try {
        const bytes = new Uint8Array(await req.input.arrayBuffer());
        const out = await optimize(bytes, req.options, { backend: createWasmBackend(), onProgress: (event) => send({ type: "progress", id: req.id, event }) });
        send({ type: "result", id: req.id, bytes: out.bytes?.slice().buffer, report: out.report });
      } catch (e) {
        send({ type: "error", id: req.id, error: serializeError(e) });
      }
    })();
  }
  terminate() {
    this.terminated = true;
  }
}

afterEach(() => {
  FakeWorker.instances = [];
});

describe("client", () => {
  it("runs a job in a worker, reports progress and builds a correctly typed result", async () => {
    const c = createCompressor({ workerFactory: () => new FakeWorker() as unknown as Worker });
    const jpg = await toJpeg(photoLike(200, 150), { quality: 97 });
    const file = new File([jpg as BlobPart], "holiday.photo.JPG", { type: "image/png" }); // wrong MIME on purpose
    const stages: string[] = [];
    const r = await c.compress(file, { autoFormats: ["webp"], onProgress: (e) => stages.push(e.stage) });
    expect(r.outputFormat).toBe("webp");
    expect(r.blob.type).toBe("image/webp");
    expect(r.fileName).toBe("holiday.photo.webp");
    expect(r.blob.size).toBe(r.outputBytes);
    expect(stages).toContain("encoding");
    c.terminate();
  });

  it("returns the original blob relabelled with the detected type", async () => {
    const png = await toPng(screenshotLike(20, 20));
    const file = new File([png as BlobPart], "x.jpg", { type: "image/jpeg" });
    const r = buildResult(file, undefined, { ...(await optimize(png, { mode: "lossless", minSavingsRatio: 0.99 }, { backend: createWasmBackend() })).report, usedOriginal: true });
    expect(r.blob.type).toBe("image/png");
    expect(r.fileName).toBe("x.png");
    expect(r.blob.size).toBe(png.length);
  });

  it("cancels a running job by terminating its worker", async () => {
    const c = createCompressor({ workerFactory: () => new FakeWorker("hang") as unknown as Worker });
    const ac = new AbortController();
    const p = c.compress(new Blob([await toPng(screenshotLike(10, 10)) as BlobPart]), { signal: ac.signal });
    await Promise.resolve();
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "ABORTED", name: "AbortError" });
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it("removes queued jobs on abort and limits concurrency", async () => {
    const c = createCompressor({ maxWorkers: 1, workerFactory: () => new FakeWorker("hang") as unknown as Worker });
    const png = new Blob([await toPng(screenshotLike(10, 10)) as BlobPart]);
    const a1 = new AbortController();
    const a2 = new AbortController();
    const p1 = c.compress(png, { signal: a1.signal });
    const p2 = c.compress(png, { signal: a2.signal });
    expect(FakeWorker.instances.length).toBe(1);
    a2.abort();
    await expect(p2).rejects.toMatchObject({ code: "ABORTED" });
    expect(FakeWorker.instances[0].terminated).toBe(false);
    a1.abort();
    await expect(p1).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("surfaces worker crashes as WORKER_ERROR and recovers with a new worker", async () => {
    let n = 0;
    const c = createCompressor({ workerFactory: () => new FakeWorker(n++ === 0 ? "crash" : "ok") as unknown as Worker });
    const png = new Blob([await toPng(screenshotLike(30, 30)) as BlobPart]);
    await expect(c.compress(png)).rejects.toMatchObject({ code: "WORKER_ERROR" });
    const r = await c.compress(png);
    expect(r.outputBytes).toBeGreaterThan(0);
  });

  it("recycles the worker after a large image to release WASM memory", async () => {
    const c = createCompressor({ recycleAfterPixels: 1000, workerFactory: () => new FakeWorker() as unknown as Worker });
    await c.compress(new Blob([await toPng(screenshotLike(50, 50)) as BlobPart]));
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it("propagates typed engine errors", async () => {
    const c = createCompressor({ workerFactory: () => new FakeWorker() as unknown as Worker });
    await expect(c.compress(new Blob([new Uint8Array(32).fill(9)]))).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
  });

  it("rejects oversized input before reading it, and non-Blob input", async () => {
    const c = createCompressor({ workerFactory: () => new FakeWorker() as unknown as Worker });
    const big = { size: 1e12 } as Blob;
    Object.setPrototypeOf(big, Blob.prototype);
    await expect(c.compress(big)).rejects.toMatchObject({ code: "INPUT_TOO_LARGE" });
    await expect(c.compress("nope" as unknown as Blob)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("requires Workers unless main-thread execution is explicitly allowed", async () => {
    vi.stubGlobal("Worker", undefined);
    try {
      const png = new Blob([await toPng(screenshotLike(10, 10)) as BlobPart]);
      await expect(createCompressor().compress(png)).rejects.toMatchObject({ code: "UNSUPPORTED_ENVIRONMENT" });
      const r = await createCompressor({ allowMainThread: true }).compress(png);
      expect(r.fallbacks.join()).toMatch(/main-thread/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("derives file names safely", () => {
    expect(fileNameFor("a.b.png", "jpeg")).toBe("a.b.jpg");
    expect(fileNameFor(undefined, "webp")).toBe("image.webp");
    expect(fileNameFor("../../etc/x.png", "avif")).toBe(".._.._etc_x.avif");
  });
});
