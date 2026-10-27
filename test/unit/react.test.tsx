// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { Compressor } from "../../src/client.js";
import { useOptiq, type UseOptiqState } from "../../src/react.js";
import type { CompressionResult } from "../../src/types.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function harness(compressor: Compressor) {
  const states: UseOptiqState[] = [];
  const container = document.createElement("div");
  const root = createRoot(container);
  // One stable component type, so re-renders update it instead of remounting.
  function Probe({ file, options }: { file: Blob | null; options: Record<string, unknown> }) {
    states.push(useOptiq(file, { compressor, ...options }));
    return null;
  }
  const render = (file: Blob | null, options: Record<string, unknown> = {}) =>
    act(async () => {
      root.render(createElement(Probe, { file, options }));
    });
  return { states, render, root };
}

const deferred = () => {
  let resolve!: (r: CompressionResult) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<CompressionResult>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};

describe("useOptiq", () => {
  it("goes idle -> compressing (with progress) -> done", async () => {
    const d = deferred();
    let seen: { onProgress?: (e: never) => void } = {};
    const compressor = { compress: (_f: Blob, o: typeof seen) => ((seen = o), d.promise), terminate() {} } as unknown as Compressor;
    const { states, render, root } = harness(compressor);
    await render(null);
    expect(states.at(-1)!.status).toBe("idle");
    await render(new Blob(["x"]));
    expect(states.at(-1)!.status).toBe("compressing");
    await act(async () => seen.onProgress!({ stage: "encoding", progress: 0.5, candidatesTried: 1, candidateBudget: 4 } as never));
    expect(states.at(-1)!.progress?.stage).toBe("encoding");
    await act(async () => d.resolve({ outputBytes: 1 } as CompressionResult));
    expect(states.at(-1)!.status).toBe("done");
    expect(states.at(-1)!.result?.outputBytes).toBe(1);
    await act(async () => root.unmount());
  });

  it("aborts the previous job when the file changes, and reports errors", async () => {
    const signals: AbortSignal[] = [];
    const compressor = {
      compress: (_f: Blob, o: { signal: AbortSignal }) => {
        signals.push(o.signal);
        return new Promise((_, reject) => o.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      },
      terminate() {},
    } as unknown as Compressor;
    const { states, render, root } = harness(compressor);
    await render(new Blob(["a"]));
    await render(new Blob(["b"]));
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    await act(async () => states.at(-1)!.cancel());
    expect(states.at(-1)!.status).toBe("cancelled");
    await act(async () => root.unmount());
  });

  it("does not restart for an equal options object created on every render", async () => {
    let calls = 0;
    const compressor = { compress: () => (calls++, new Promise(() => {})), terminate() {} } as unknown as Compressor;
    const { render, root } = harness(compressor);
    const file = new Blob(["x"]);
    await render(file, { mode: "fast" });
    await render(file, { mode: "fast" });
    expect(calls).toBe(1);
    await render(file, { mode: "balanced" });
    expect(calls).toBe(2);
    await act(async () => root.unmount());
  });
});
