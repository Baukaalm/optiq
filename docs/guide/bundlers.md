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
| jpegli encoder / libjpeg-turbo decoder | 148 KB / 166 KB | JPEG output / JPEG input |
| SVGO + resvg (verification) | 805 KB JS + 2.5 MB wasm | SVG input |
| libwebp enc / dec | 346 KB / 138 KB | WebP |
| libavif enc / dec | 3.5 MB / 1.2 MB | AVIF (consider removing it from `autoFormats` on slow networks) |
| oxipng, png | 164 KB, 181 KB | PNG |
| resize | 35 KB | `maxWidthOrHeight` |

## Cross-origin isolation (faster AVIF)

Not required, but it makes AVIF encoding about 1.5–1.7× faster. If the page is cross-origin isolated, jSquash
switches to multi-threaded builds of the AVIF encoder and oxipng, which run as extra threads inside Optiq's worker.
Optiq then also splits images of 1 MP and up into 2×2 AVIF tiles so that the threads can work in parallel.

To enable it, serve the page with these headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`require-corp` blocks cross-origin images, scripts and iframes that do not send CORP/CORS headers. Check your
third-party embeds first; `credentialless` is a softer alternative in Chromium and Firefox. GitHub Pages cannot set
these headers, so the hosted demo runs single-threaded.

Measured with `bench/browser/avif-threads.mjs`: synthetic photo, `targetFormat: "avif"`, `balanced`, Apple M4 Pro.

| | 1.9 MP, one image | 6 MP, one image | 6 MP, four at once |
|---|---|---|---|
| Chromium 156 | 1.89 → 1.23 s (1.54×) | 4.11 → 2.59 s (1.59×) | 8.5 → 5.5 s (1.56×) |
| Firefox 157 | 2.01 → 1.25 s (1.62×) | 4.28 → 2.60 s (1.65×) | 8.9 → 5.5 s (1.62×) |
| WebKit 27 | 1.70 → 1.03 s (1.65×) | 3.69 → 2.16 s (1.71×) | 7.7 → 4.7 s (1.65×) |

Without tiles, threads alone gave 1.35–1.46×. Tiles cost 1.0% more bytes (median of 38 encodes of real images, worst
+8%) at the same SSIMULACRA2. That is why they are used only on isolated pages and only for larger images.

Multi-threaded encodes are not bit-for-bit reproducible: the same image can come out a few bytes different between
runs. The browser suite runs the whole test set on an isolated page as well.
