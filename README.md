<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Baukaalm/optiq/main/brand/logo-white.svg" />
    <img src="https://raw.githubusercontent.com/Baukaalm/optiq/main/brand/logo-black.svg" width="96" height="96" alt="Optiq" />
  </picture>
</p>

<h1 align="center">Optiq</h1>

**[Try the demo](https://baukaalm.github.io/optiq/try)** · **[Documentation](https://baukaalm.github.io/optiq/)** · [Benchmarks](https://baukaalm.github.io/optiq/benchmarks)

Browser-side image optimisation for uploads. For every image Optiq encodes a bounded set of candidates
(MozJPEG, libwebp, libavif, oxipng — compiled to WebAssembly), **measures** each one, and returns the smallest
output that satisfies your constraint:

- `lossless` — decoded pixels (including alpha) are verified identical to the input;
- `visually-lossless` — pixels may differ; SSIM ≥ 0.99 against the input (configurable);
- `balanced` (default) — SSIM ≥ 0.975, smaller search budget, faster AVIF preset.

The same engine also runs in Node and powers:
- a CLI (`npx optiq-image`);
- a Vite plugin;
- an MCP server for AI agents ([`optiq-mcp`](#mcp-server-optiq-mcp), source in `mcp/`).

In the browser, work runs in a Web Worker; the main thread only posts a `Blob` and receives an `ArrayBuffer`. Results carry the
chosen codec/settings, every candidate tried, the measured quality, warnings, fallbacks and unmet constraints.

> Benchmarks: see [Benchmark results](#benchmark-results) and `bench/results/RESULTS.md`. Optiq is not
> uniformly better than the alternatives; the trade-offs (size vs. time vs. memory) are listed there per category.

## Install

```sh
pnpm add optiq-image      # or npm / yarn
```

Requirements: an ES2022 browser with module Workers and WebAssembly (Chrome/Edge 80+, Firefox 114+, Safari 15+).
AVIF *output* is only useful where your audience can decode AVIF (Chrome 85+, Firefox 93+, Safari 16.4+); remove it
with `autoFormats: ["jpeg", "png", "webp"]` otherwise.

### Bundler setup (Vite 7 and 8)

```ts
// vite.config.ts
export default defineConfig({
  worker: { format: "es" }, // codecs are loaded with dynamic import() inside the worker
  optimizeDeps: {           // dev only: pre-bundling breaks `new URL("x.wasm", import.meta.url)`
    exclude: ["optiq-image", "@jsquash/jpeg", "@jsquash/png", "@jsquash/webp", "@jsquash/avif", "@jsquash/oxipng", "@jsquash/resize"],
  },
});
```

webpack 5 and Parcel 2 understand `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })` and
`new URL("*.wasm", import.meta.url)` natively. For anything else pass `workerFactory` to `createCompressor`.
Each codec is a separate chunk, fetched on first use (AVIF ≈ 3.5 MB, others 35–350 KB).

## Usage

```ts
import { compressImage, isOptiqError } from "optiq-image";

const controller = new AbortController();
try {
  const result = await compressImage(file, {
    mode: "balanced",
    maxWidthOrHeight: 2560,
    signal: controller.signal,
    onProgress: (e) => console.log(e.stage, Math.round(e.progress * 100), e.bestBytes),
  });
  result.blob;            // Blob with the right MIME type (image/avif, image/webp, ...)
  result.fileName;        // "IMG_0042.webp" — extension matches the encoded bytes
  result.sizeReductionRatio, result.qualityMetric, result.codec, result.warnings;
  if (!result.constraintsMet) console.warn(result.unmetConstraints);
} catch (e) {
  if (isOptiqError(e)) console.warn(e.code, e.message); // e.g. UNSUPPORTED_FORMAT, ABORTED
  // the original `file` is untouched — upload it instead
}
```

React:

```tsx
function useCompressed(file?: File) {
  const [state, set] = useState<{ result?: CompressionResult; error?: unknown; progress: number }>({ progress: 0 });
  useEffect(() => {
    if (!file) return;
    const ac = new AbortController();
    compressImage(file, { signal: ac.signal, onProgress: (e) => set((s) => ({ ...s, progress: e.progress })) })
      .then((result) => set({ result, progress: 1 }), (error) => !ac.signal.aborted && set({ error, progress: 0 }));
    return () => ac.abort(); // terminates the worker job
  }, [file]);
  return state;
}
```

For explicit control over workers use `createCompressor({ maxWorkers, workerFactory, codecFallback, allowMainThread, recycleAfterPixels })`.

### Options

| Option | Default | Meaning |
|---|---|---|
| `mode` | `"balanced"` | `lossless`, `visually-lossless`, `balanced`, `fast` (no AVIF, ≤ 5 encodes; ~3× faster) |
| `minQuality` | 0.99 / 0.975 | SSIM threshold (ignored in lossless). Gradients use a stricter value half-way to 1 |
| `maxOutputBytes` | – | Upper bound. If impossible without violating quality, the result lists it in `unmetConstraints` |
| `maxWidthOrHeight` | – | Downscale longest side. In `lossless` mode only with `allowLossyResize: true` |
| `targetFormat` | `"auto"` | `auto`, `original`, `jpeg`, `png`, `webp`, `avif` |
| `autoFormats` | all four | Formats `auto` may choose |
| `allowFormatConversion` | `true` | `false` keeps the input format |
| `maxCandidates` | 10 / 16 / 4 | Encode budget (balanced / visually-lossless / lossless) |
| `searchStrategy` | `"binary"` | `fixed` = one encode per format at a preset quality |
| `preserveMetadata` | `true` | Keep EXIF/XMP/ICC. `false` strips EXIF (incl. GPS) and XMP; non-sRGB ICC is kept anyway |
| `preserveAnimation` | `true` | Animated inputs are only optimised at container level. `false` permits flattening to frame 1 |
| `minSavingsRatio` | `0.02` | Keep the original unless re-encoding saves at least this |
| `maxInputBytes` / `maxInputPixels` | 100 MiB / 50 MP | Checked before reading / before decoding |
| `onUnmetConstraints` | `"best-effort"` | `throw` → `CONSTRAINTS_UNSATISFIABLE` |

Progress stages: `reading → probing → decoding → (resizing) → analyzing → encoding … → finalizing → done`.

Error codes: `INVALID_INPUT`, `UNSUPPORTED_FORMAT`, `MALFORMED_INPUT`, `INPUT_TOO_LARGE`, `INVALID_OPTIONS`,
`INCOMPATIBLE_OPTIONS` (e.g. JPEG requested for a transparent image), `CONSTRAINTS_UNSATISFIABLE`,
`CODEC_UNAVAILABLE`, `UNSUPPORTED_ENVIRONMENT`, `WORKER_ERROR`, `ABORTED` (`name === "AbortError"`).

## React, CLI, Vite plugin

```tsx
import { useOptiq } from "optiq-image/react";
const { status, result, progress, cancel } = useOptiq(file, { mode: "fast" });
```

[View example](https://github.com/Baukaalm/optiq/blob/main/docs/examples/PhotoUploadForm.tsx) (upload form with progress, cancel and S3) · [React hook docs](https://baukaalm.github.io/optiq/guide/react)

```sh
npx optiq-image ./photos --out ./photos-optimized      # static images, in parallel worker threads
```

```ts
import { optiq } from "optiq-image/vite";               // optimises build output in place
export default defineConfig({ plugins: [optiq()] });
```

## MCP server (`optiq-mcp`)

This repository contains an MCP server, published on npm as
[`optiq-mcp`](https://www.npmjs.com/package/optiq-mcp) and in the official MCP Registry as
`io.github.Baukaalm/optiq-mcp`. Its source is in [`mcp/`](https://github.com/Baukaalm/optiq/tree/main/mcp):
- [`mcp/src/index.ts`](https://github.com/Baukaalm/optiq/blob/main/mcp/src/index.ts) is the implementation;
- [`mcp/test/`](https://github.com/Baukaalm/optiq/tree/main/mcp/test) holds end-to-end tests that run it with the
  official MCP client;
- [`mcp/server.json`](https://github.com/Baukaalm/optiq/blob/main/mcp/server.json) is the registry entry.

It is a local stdio server built on the TypeScript MCP SDK, and it gives AI agents two tools for the images in a
project:

| Tool | Writes | What it does |
|---|---|---|
| `analyze_images` | no (`readOnlyHint`) | Dry run. Per image it reports the format Optiq would choose, the bytes before and after, and the measured quality |
| `optimize_images` | yes (`idempotentHint`) | `write: "in-place"` keeps formats and names. `write: "out-dir"` writes to a folder and may change formats |

```sh
claude mcp add optiq -- npx -y optiq-mcp                                    # Claude Code
```
```json
{ "mcpServers": { "optiq": { "command": "npx", "args": ["-y", "optiq-mcp"] } } }
```

The JSON config works for Claude Desktop, Cursor and other MCP clients.

For agents that drive the CLI instead, there is an
[Agent Skill](https://github.com/Baukaalm/optiq/blob/main/skills/optiq/SKILL.md). The documentation site also has an
[llms.txt](https://baukaalm.github.io/optiq/llms.txt). See the [agents guide](https://baukaalm.github.io/optiq/guide/agents).

## Uploading to S3

```ts
import { compressAndUpload } from "optiq-image/upload";
const out = await compressAndUpload(file, { requestPresignedUpload: (req) => fetch("/api/presign", …).then((r) => r.json()) });
```

Compression is optional and never blocks the upload: if it fails or does not help, the original is uploaded.
Presigned URLs must come from your backend — see [docs/guide/s3.md](https://github.com/Baukaalm/optiq/blob/main/docs/guide/s3.md) for the contract and a backend sketch.

## Supported formats

| | Input | Output |
|---|---|---|
| JPEG | 8-bit RGB/gray (CMYK, 12-bit: kept as is) | MozJPEG, progressive |
| PNG | all incl. 16-bit, APNG (container-level only) | oxipng (lossless) |
| WebP | lossy, lossless, animated (container-level only) | lossy / lossless |
| AVIF | still (animated / rotated: kept as is) | libavif |
| GIF | static (converted), animated (kept as is) | – |
| HEIC/HEIF | detected → `UNSUPPORTED_FORMAT` | – |
| SVG | detected → returned unchanged, never rasterised | – |

Formats are detected from file content. Extensions and MIME types are ignored (a `.jpg` that is a PNG is a PNG).

## Guarantees and limitations

- **Lossless** means decoded RGBA equality, verified per candidate, for the decoder Optiq uses. JPEG
  decoders are not bit-exact across implementations, so “lossless” for a JPEG input is only ever a byte-level
  container rewrite (metadata removal), never a re-encode.
- **Transparency** is never dropped: JPEG is excluded when any pixel has alpha < 255.
- **Orientation**: EXIF orientation is applied to the pixels of re-encoded outputs (tag reset to 1) and preserved in
  container-level outputs.
- **Colour**: ICC profiles are carried into JPEG/PNG/WebP outputs. AVIF output is tagged sRGB and is not used for
  images with a non-sRGB profile. sRGB profiles are dropped only with `preserveMetadata: false` (or for AVIF output,
  where the `nclx` sRGB tag is equivalent). No colour conversion is performed.
- **Metadata**: kept by default. AVIF output is skipped when EXIF/XMP must be preserved (no AVIF metadata writer).
  With `preserveMetadata: false`, EXIF (including GPS), XMP, comments and trailing data are removed.
- **Animation** is never silently flattened.
- **SSIM is a proxy for perception**, not perception: it under-weights banding in smooth gradients and chroma
  bleeding. Validate thresholds on your own content.
- **Memory**: large images need several hundred MB inside the worker (see benchmarks). WASM memory is returned by
  terminating the worker, which happens automatically after jobs above 8 MP.
- **Speed**: searching costs multiple encodes. Use `balanced`, lower `maxCandidates`, `searchStrategy: "fixed"`, or
  drop AVIF from `autoFormats` when latency matters more than bytes.

## Licensing

Optiq: Apache-2.0. Bundled codecs (via jSquash, Apache-2.0 wrappers): MozJPEG (IJG + BSD-3 + zlib),
libwebp (BSD-3), libavif (BSD-2) with libaom (BSD-2 + AOMedia patent licence), Rust `png`, `oxipng`, `resize`
(MIT/Apache-2.0). All permit commercial redistribution with notices. No GPL code is included
(libimagequant was rejected for that reason).

## Benchmark results

24 images (`bench/corpus/manifest.json`): 10 Kodak photos (8 JPEG q92, 2 PNG), 3 phone-style 12 MP JPEGs,
2 screenshots, 2 text graphics, 4 transparent illustrations, 3 gradients. Apple M4 Pro (14 cores, 24 GB), macOS arm64, Node 24.15 and
headless Chromium 156. Every output is decoded with the same decoders and scored with the same SSIM against the
input. Full tables, per-image rows and the optimisation log: [`bench/results/RESULTS.md`](https://github.com/Baukaalm/optiq/blob/main/bench/results/RESULTS.md).

**Perceptual, all 24 images (Node; same encoders as the browser)**

| Tool | Total output | Reduction | Meets SSIM ≥ 0.975 | Median time | Median peak RSS |
|---|---|---|---|---|---|
| Optiq `balanced` | 13.25 → 5.15 MB | 61.1% | 24/24 | 1.8 s | 301 MB |
| Optiq `fast` (no AVIF, ≤ 5 encodes) | 13.25 → 5.49 MB | 58.5% | 24/24 | 434 ms | 173 MB |
| Optiq `balanced`, `preserveMetadata: false` | 13.25 → 4.73 MB | 64.3% | 24/24 | 1.5 s | 297 MB |
| Optiq `visually-lossless` | 13.25 → 6.38 MB | 51.8% | 24/24 (≥ 0.99: 24/24) | 2.3 s | 325 MB |
| libvips WebP q80 | 13.25 → 6.50 MB | 51.0% | 17/24 | 59 ms | 105 MB |
| libvips MozJPEG q80 (opaque only) | 12.82 → 6.87 MB | 46.4% | 11/20 | 54 ms | 106 MB |
| libvips AVIF q50 | 13.25 → 3.41 MB | 74.3% | 11/24 (photos: 0/10) | 590 ms | 151 MB |

**Browser (Chromium), against browser-image-compression 2.0.2 and canvas**

| Tool | Total output | Reduction | Meets SSIM ≥ 0.975 | Median time |
|---|---|---|---|---|
| Optiq `balanced` | 13.25 → 5.15 MB | 61.1% | 24/24 | 1.4 s |
| Optiq `fast` | 13.25 → 5.49 MB | 58.5% | 24/24 | 349 ms |
| browser-image-compression `initialQuality: 0.8` | 13.25 → 10.21 MB | 22.9% | 19/24 | 78 ms |
| browser-image-compression `fileType: webp, 0.8` | 13.25 → 6.52 MB | 50.8% | 18/24 | 37 ms |
| browser-image-compression `maxSizeMB: 1` | 13.25 → 7.14 MB | 46.1% | 21/24 (3 large photos were downscaled, not scored) | 128 ms |
| canvas WebP 0.8 | 13.25 → 6.52 MB | 50.8% | 18/24 | 36 ms |

What the numbers say:

- **Per image, no baseline dominated Optiq `balanced`** (smaller *and* higher SSIM) on any image.
  `balanced` dominated MozJPEG q80 on 11/20, WebP q80 on 10/24, browser-image-compression WebP 0.8 on 10/24 and
  AVIF q50 on 2/24; everything else is a trade-off.
- **AVIF q50 is much smaller on photos, but at SSIM 0.93–0.97**, below the 0.975 constraint on all 10 Kodak photos.
  Optiq spends bytes to stay above the threshold; whether that threshold is right for you is a product decision.
- **Category matters.** Screenshots/text: −90.6% / −91.8% vs. −62.8% / −46.6% for WebP q80 (lossless WebP and
  screen-content AVIF win there). Large 12 MP phone photos: −41.5% with metadata kept (AVIF excluded because EXIF
  must be preserved), −47.7% with `preserveMetadata: false`, vs. −30.7% for WebP q80.
- **Optiq is slow and memory-hungry by comparison.** It runs several encodes plus decodes and SSIM per
  image: 1–4 s typical, 3–4 s for 12 MP photos (8–12 s when AVIF is allowed), 16.6 s for a 5 MP screenshot in
  `balanced` and 38 s in `visually-lossless`; median peak RSS ≈ 300 MB, up to 1.1 GB. Single canvas/libvips encodes
  take 5–800 ms. Work runs in a worker, so the UI stays responsive (max main-thread gap 11 ms during a 12 MP job).

**Lossless** (`sc-lossless`, Node): pixel-exact on 24/24 and never larger than the input (total −20.4%).
PNG photos −27% (oxipng), screenshots −76% and text −91% (about the same as libvips lossless WebP effort 6),
transparent illustrations −42% and gradients −66%, where libvips PNG max compression reached −60% / −76% but its
outputs were not pixel-exact against the reference. JPEG inputs: only metadata can be removed losslessly (0% with
the default `preserveMetadata: true`; no jpegtran in this build).

## Development

Toolchain: Node ≥ 20 (tested with 24.15), pnpm 11, Playwright Chromium (`pnpm exec playwright install chromium chromium-headless-shell`).
No Rust toolchain is required: all WASM comes prebuilt from pinned jSquash packages.

```sh
pnpm install
pnpm typecheck
pnpm test             # unit + integration tests in Node (real WASM codecs)
pnpm test:browser     # builds, bundles a consumer page with Vite, runs it in Chromium (incl. CSP/no-WASM fallback)
pnpm test:demo        # demo end-to-end (light/dark/mobile): compress → presign → PUT to mock S3
pnpm pack:check       # pack the tarball, install it in a fresh Vite app, typecheck, build, run (does not publish)
pnpm demo             # React + HeroUI demo with a mock presigned-S3 backend
pnpm docs:dev         # VitePress documentation site
pnpm bench:corpus     # download/render the benchmark corpus (24 images)
pnpm bench:node       # Optiq vs libvips (sharp), with peak RSS per run
pnpm bench:browser    # Optiq vs browser-image-compression and canvas, in Chromium
pnpm bench:report     # writes bench/results/RESULTS.md
```

Documentation site (guides, API reference generated from the TSDoc comments, benchmarks, architecture):
`pnpm docs:dev`, or read the Markdown in [`docs/`](https://github.com/Baukaalm/optiq/blob/main/docs/). Design notes: [docs/architecture.md](https://github.com/Baukaalm/optiq/blob/main/docs/architecture.md).
