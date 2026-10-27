# Bundlers and deployment

Optiq ships plain ES modules. It starts its worker with the standard pattern
`new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`, and the codecs locate their `.wasm`
files with `new URL("x.wasm", import.meta.url)`. Bundlers that understand these patterns emit the worker and the
WASM files as separate assets automatically.

| Setup | Status |
|---|---|
| Vite 7 and Vite 8 (dev server and production build) | Tested in CI: the packed tarball is installed into a fresh app, typechecked, built and run in Chromium (`VITE_VERSION=8 pnpm pack:check`) |
| webpack 5, Parcel 2, Next.js | Not tested here; they support the patterns above |

## Vite

```ts
export default defineConfig({
  worker: { format: "es" },
  optimizeDeps: {
    exclude: ["optiq-image", "@jsquash/jpeg", "@jsquash/png", "@jsquash/webp", "@jsquash/avif", "@jsquash/oxipng", "@jsquash/resize"],
  },
});
```

- `worker.format: "es"` is required: the worker loads codecs with dynamic `import()`, which the default IIFE worker
  format cannot code-split.
- `optimizeDeps.exclude` matters in the dev server only.

## Next.js / SSR

Call Optiq only in the browser (inside an event handler or `useEffect`, or via `import()` in a client
component). It touches `Worker`, `OffscreenCanvas` and `Blob`, none of which exist during server rendering.

## Custom worker loading

If your bundler cannot follow `new URL(..., import.meta.url)`, or you want to host the worker elsewhere, build
`optiq-image/worker` as a separate module-worker entry with your bundler (it imports the `@jsquash/*` codecs,
so it must be bundled, not copied) and pass its URL:

```ts
import { createCompressor } from "optiq-image";

const compressor = createCompressor({
  workerFactory: () => new Worker("/assets/optiq-worker.js", { type: "module" }),
});
```

## Content Security Policy

- WebAssembly needs `script-src 'wasm-unsafe-eval'` (or `'unsafe-eval'`).
- The worker needs `worker-src 'self'` (or the origin you serve it from).

Without `'wasm-unsafe-eval'` Optiq falls back to the browser's canvas encoders and reports it in
`result.fallbacks`; AVIF output is then unavailable in Chromium. This path is covered by an automated browser test.

## What gets downloaded

| Chunk | Size (uncompressed) | When |
|---|---|---|
| Main-thread API | ≈ 10 KB | always |
| Worker + engine | ≈ 47 KB | first compression |
| MozJPEG enc / dec | 252 KB / 166 KB | JPEG input or output |
| libwebp enc / dec | 346 KB / 138 KB | WebP |
| libavif enc / dec | 3.5 MB / 1.2 MB | AVIF (consider removing it from `autoFormats` on slow networks) |
| oxipng, png | 164 KB, 181 KB | PNG |
| resize | 35 KB | `maxWidthOrHeight` |

## Cross-origin isolation

Not required. If the page is cross-origin isolated, jSquash picks multi-threaded builds of the AVIF encoder and
oxipng; that configuration is not tested or benchmarked here.
