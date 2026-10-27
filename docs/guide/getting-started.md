# Getting started

## Install

```sh
pnpm add optiq-image   # npm i optiq-image / yarn add optiq-image
```

Requirements: an ES2022 browser with module Web Workers and WebAssembly — Chrome/Edge 80+, Firefox 114+,
Safari 15+. The browser test suite runs in CI on Chromium, Firefox and WebKit (Safari's engine, via Playwright);
the demo and documentation-site end-to-end tests run on Chromium.

## Configure Vite

```ts
// vite.config.ts
import { defineConfig } from "vite";

export default defineConfig({
  worker: { format: "es" }, // codecs are loaded with dynamic import() inside the worker
  optimizeDeps: {
    // dev server only: pre-bundling breaks `new URL("codec.wasm", import.meta.url)`
    exclude: ["optiq-image", "@jsquash/jpeg", "@jsquash/png", "@jsquash/webp", "@jsquash/avif", "@jsquash/oxipng", "@jsquash/resize"],
  },
});
```

Other bundlers: see [Bundlers and deployment](./bundlers).

## Compress a file

```ts
import { compressImage, isOptiqError } from "optiq-image";

input.addEventListener("change", async () => {
  const file = input.files![0];
  try {
    const result = await compressImage(file, { mode: "balanced" });
    console.log(`${result.originalFormat} → ${result.outputFormat}`, result.sizeReductionRatio, result.qualityMetric);
    upload(result.blob, result.fileName, result.mimeType);
  } catch (e) {
    if (isOptiqError(e)) console.warn(e.code, e.message);
    upload(file, file.name, file.type); // the original is never modified
  }
});
```

`result.blob` has the MIME type of the encoded bytes and `result.fileName` the matching extension
(`IMG_0042.HEIC.jpg` → `IMG_0042.HEIC.webp`). If no candidate beats the original by at least 2%,
`result.usedOriginal` is `true` and `blob` is the input itself.

## Progress and cancellation

```ts
const controller = new AbortController();
cancelButton.onclick = () => controller.abort();

const result = await compressImage(file, {
  signal: controller.signal,
  onProgress: (e) => {
    bar.value = e.progress; // 0..1
    label.textContent = `${e.stage} ${e.candidatesTried}/${e.candidateBudget}`;
    if (e.bestBytes) estimate.textContent = `≈ ${Math.round((1 - e.bestBytes / file.size) * 100)}% smaller`;
  },
});
```

Aborting terminates the worker running the job (a WASM encode cannot be interrupted otherwise) and rejects with
a `OptiqError` whose `code` is `ABORTED` and `name` is `AbortError`.

## React

```tsx
import { useEffect, useState } from "react";
import { compressImage, type CompressionResult } from "optiq-image";

export function useCompressed(file?: File) {
  const [state, setState] = useState<{ result?: CompressionResult; error?: unknown; progress: number }>({ progress: 0 });
  useEffect(() => {
    if (!file) return;
    const ac = new AbortController();
    compressImage(file, { signal: ac.signal, onProgress: (e) => setState((s) => ({ ...s, progress: e.progress })) }).then(
      (result) => setState({ result, progress: 1 }),
      (error) => !ac.signal.aborted && setState({ error, progress: 0 }),
    );
    return () => ac.abort();
  }, [file]);
  return state;
}
```

A complete React app (HeroUI) with a multi-file queue, before/after comparison and S3 upload lives in the
repository's [`demo/`](https://github.com/Baukaalm/optiq/tree/main/demo) folder — run it with `pnpm demo`, or [try it online](/try).

## Vue

```ts
import { ref, watch, onScopeDispose, type Ref } from "vue";
import { compressImage, type CompressionResult } from "optiq-image";

export function useCompressed(file: Ref<File | undefined>) {
  const result = ref<CompressionResult>();
  const progress = ref(0);
  let ac: AbortController | undefined;
  watch(file, async (f) => {
    ac?.abort();
    if (!f) return;
    ac = new AbortController();
    result.value = await compressImage(f, { signal: ac.signal, onProgress: (e) => (progress.value = e.progress) });
  });
  onScopeDispose(() => ac?.abort());
  return { result, progress };
}
```

## More control

`compressImage` uses a shared compressor. Create your own to set the worker count, the fallback policy or a
custom worker:

```ts
import { createCompressor } from "optiq-image";

const compressor = createCompressor({
  maxWorkers: 1,            // default min(2, cores − 1)
  codecFallback: "canvas",  // or "none"
  idleTimeoutMs: 30_000,
  recycleAfterPixels: 8e6,  // terminate the worker after big images to release WASM memory
});
const result = await compressor.compress(file, { mode: "visually-lossless" });
compressor.terminate();
```
