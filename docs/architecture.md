# SmartCompress architecture

## Goals and non-goals

SmartCompress optimises **raster images in the browser before upload**. For each image it looks for the smallest
encoding that satisfies an explicit constraint:

| Mode | Constraint | Verification |
|---|---|---|
| `lossless` | decoded RGBA pixels identical to the input | every re-encoded candidate is decoded and compared byte-for-byte; container rewrites copy image data verbatim |
| `visually-lossless` | SSIM ≥ 0.99 (configurable) | every candidate is decoded and scored against the reference |
| `balanced` | SSIM ≥ 0.975 (configurable), smaller search budget, faster AVIF preset | as above |

Perceptual modes never claim to be lossless: decoded pixels differ, and the result says so (`qualityMetricName: "ssim"`).

Non-goals: video/audio/PDF, a new codec, SVG rasterisation, HEIC decoding (see “Formats”).

## Component map

```
main thread                                  Web Worker (one job at a time per worker)
───────────                                  ─────────────────────────────────────────
compressImage / createCompressor  ──Blob──▶  worker.ts → run.ts
  client.ts: queue, pool (≤2 workers),         engine.ts  (environment-agnostic pipeline)
  AbortSignal → worker.terminate(),              probe.ts + container/*  (format sniffing, headers, metadata)
  progress relay, typed errors,                  classify.ts             (heuristic category)
  Blob/File result with correct type+name        plan.ts                 (codec/settings plan per category & mode)
                                  ◀─ArrayBuffer─ quality.ts              (SSIM, exact equality)
upload.ts: presigned PUT/POST, progress,       codecs/wasm.ts   (jSquash: MozJPEG, libwebp, libavif, png, oxipng, resize)
  original-file fallback                       codecs/canvas.ts (OffscreenCanvas fallback)
                                               codecs/fallback.ts (per-operation fallback + reporting)
```

`engine.ts` has no DOM or Worker dependency: the same code runs in the worker, on the main thread (opt-in), and in
Node (tests and benchmarks, `src/node.ts`).

## Pipeline

1. **Limits before work.** `maxInputBytes` is checked on the main thread from `Blob.size` (nothing is read). In the
   worker, the header is parsed and `width × height` is checked against `maxInputPixels` *before* decoding
   (decompression-bomb guard). PNG `iCCP` inflation is capped at 16 MiB.
2. **Probe.** Format comes from magic bytes only (`probe.ts`); file extension and MIME type are ignored. Container
   parsers read dimensions, alpha, animation (APNG `acTL`, WebP `ANIM`, GIF frame count, AVIF `avis`), bit depth,
   EXIF orientation, ICC, EXIF and XMP. Malformed structure → `MALFORMED_INPUT`.
3. **Policy.** Allowed output formats are derived from `targetFormat`, `allowFormatConversion`, `autoFormats`, then
   restricted by what the image needs. Each restriction either removes a format with a warning or, if that format was
   explicitly requested, fails with `INCOMPATIBLE_OPTIONS` and an actionable message:
   - transparency → no JPEG (checked on decoded pixels: a PNG with an all-opaque alpha channel may become JPEG);
   - animation + `preserveAnimation` (default) → container-level optimisation only; conversion is rejected;
   - non-sRGB ICC, or EXIF/XMP with `preserveMetadata` → no AVIF (we cannot write those into ISOBMFF yet);
   - CMYK JPEG, >8-bit JPEG, AVIF `irot`/`imir`, non-RGB ICC → no re-encoding (original kept);
   - `lossless` → no JPEG/AVIF re-encodes; resizing requires `allowLossyResize`.
4. **Container candidate.** The input itself, or — with `preserveMetadata: false` — a rewrite that drops EXIF/XMP/
   comments/trailers while copying image data byte-for-byte (JPEG segments, PNG chunks, WebP chunks). An EXIF
   orientation ≠ 1 is kept as a 26-byte EXIF block so stripping never rotates the image.
5. **Decode → orient → (resize).** Decoders never apply orientation; the engine rotates/flips the pixels itself so
   behaviour is identical across decoders. Resizing uses Lanczos3 in linear light with premultiplied alpha.
6. **Classify.** `classify.ts` samples up to 24×24 patches of 16×16 contiguous pixels and computes flat-pair share,
   hard-edge share, smooth-step share, unique colours, dominant-colour share and transparency. Fixed thresholds map
   this to `photo | screenshot | text-graphic | illustration | transparent-illustration | gradient`. The category only
   decides *what to try first*; validity is always decided by measurement, so a misclassification costs time or
   bytes, never correctness. No ML model: nothing in the benchmark suggests one would pay for its size.
   On the benchmark corpus the classifier matched the hand-assigned category on 23/24 images; the miss (a
   presentation slide labelled `illustration` instead of `text-graphic`) gets the same codec strategy.
7. **Plan.** `plan.ts` orders candidates per category:
   - photo: AVIF (4:2:0) → WebP → MozJPEG (4:2:0);
   - screenshot / text / illustration: lossless PNG (oxipng) and lossless WebP first, then WebP with sharp YUV,
     AVIF 4:4:4, MozJPEG 4:4:4;
   - transparent: as graphics, without JPEG; AVIF alpha quality raised by 25;
   - gradient: photo order plus lossless candidates and a stricter SSIM threshold (half-way to 1), because banding
     appears before SSIM drops.
8. **Bounded search with early stopping** (`maxCandidates` encodes in total, shared fairly between formats):
   per lossy format, start from a mode-specific prior quality, then bisect between the highest failing and lowest
   passing quality until the gap is within the mode tolerance (5 for balanced, 3 for visually-lossless). A failing
   encode that is already larger than the best valid candidate ends that format (size grows with quality).
   `searchStrategy: "fixed"` encodes each format once at the prior quality.
9. **Large images (> 4 MP): tile-mosaic proxy.** Benchmarks of the first version showed 12 MP inputs needing
   ~10 full-resolution encodes (10–20 s, 0.8–1.4 GB peak RSS). The search now runs on a 3×3 mosaic of 512 px
   *full-resolution* tiles (≈2.4 MP, tiles 16-px aligned so codec block grids match). Only the best format (and a
   runner-up within 10%) is then encoded at full size and **verified there**; if the full image fails the threshold,
   quality is stepped up (max 3 attempts). Proxy encodes are listed in `candidates` with `proxy: true` and are never
   returned. Tiles are not a downscale: per-pixel detail, and therefore codec behaviour per block, is preserved.
   Measured on the three 12 MP photos (9 runs, v0 → current, which also includes the speed-7 change below):
   1.8–3.2× faster and 26–35% lower peak RSS; 5 outputs byte-identical, 3 grew 1.6–5.6% (the mosaic ranked formats
   slightly differently), 1 shrank 23.7% (`bench/results/RESULTS.md`, optimisation log).
10. **AVIF speed preset.** `balanced` uses libaom speed 7, `visually-lossless` speed 6. Speed 8 was the first choice
    for `balanced`; the benchmark showed it loses libaom's screen-content gains (5 MP dashboard screenshot at q50:
    45 KB at speed 8, 13.4 KB at speed 7, 13.8 KB at speed 6) while being only ~40 ms faster on 0.4 MP photos.
    Cost of the change: that screenshot now takes 16.6 s instead of 6.3 s in `balanced`.
11. **Select.** Smallest candidate that passes quality and fits `maxOutputBytes`; if none fits the byte limit, the
    smallest passing one with `unmetConstraints` (or `CONSTRAINTS_UNSATISFIABLE` with `onUnmetConstraints: "throw"`).
    If re-encoding saves less than `minSavingsRatio` (2%), the container candidate (original) wins.
12. **Metadata on output.** Re-encoded outputs get EXIF (orientation reset to 1), XMP and ICC injected into JPEG
    (APP1/APP2, multi-segment ICC), PNG (`eXIf`, `iTXt`, `iCCP`) or WebP (`VP8X` + `ICCP/EXIF/XMP`). AVIF output's
    `nclx` box is patched in place from “unspecified” to BT.709/sRGB (fixed size, so item offsets stay valid).

## Quality metric

- **SSIM** with uniform 8×8 windows at stride 4, on BT.601 Y, Cb, Cr; channel weights 6:1:1.
  Validated against the `ssim.js` reference implementation (Gaussian, “original” variant): luma SSIM agreed within
  0.002 on test images.
- **Alpha:** pixels are composited on black and on white; the worse score is used. Colour under fully transparent
  pixels is ignored, alpha errors are visible.
- **Active-window pooling:** windows that are perfectly flat *and identical* in both images are excluded from the
  mean. Without this, large untouched backgrounds in screenshots and illustrations pushed SSIM to ~0.999 even at
  very low quality (observed in the first browser run: WebP q41 on a transparent illustration scored 0.9994).
  A codec that adds noise to a flat area makes those windows active again.
- **Limitations:** SSIM is not a perceptual model of colour or banding; it under-penalises smooth-gradient banding
  (hence the stricter gradient threshold) and chroma bleeding around coloured text is only weighted 1/8 per chroma
  channel. Butteraugli/SSIMULACRA2 would be better judges but no maintained, licence-compatible WASM build was found
  that fits the bundle budget; they are listed under next steps. Scores from different metrics are never compared.
- **Exact:** lossless candidates are verified by full RGBA equality, not a metric.

## Codecs and why

| Need | Choice | Language | Licence | Size (wasm) |
|---|---|---|---|---|
| JPEG enc/dec | MozJPEG via `@jsquash/jpeg` | C → Emscripten | BSD-style (IJG/libjpeg-turbo) | 252 KB / 166 KB |
| WebP enc/dec | libwebp via `@jsquash/webp` | C → Emscripten | BSD-3 | 346 KB (SIMD) / 138 KB |
| AVIF enc/dec | libavif + libaom via `@jsquash/avif` | C → Emscripten | BSD-2 / BSD-2 + AOM patent licence | 3.5 MB / 1.2 MB |
| PNG enc/dec | `png` crate via `@jsquash/png` | Rust → wasm-bindgen | MIT/Apache-2.0 | 181 KB |
| PNG optimiser | oxipng via `@jsquash/oxipng` | Rust → wasm-bindgen | MIT | 164 KB |
| Resize | `resize` crate via `@jsquash/resize` | Rust → wasm-bindgen | MIT/Apache-2.0 | 35 KB |
| GIF first frame | own LZW decoder (≈150 lines) | TypeScript | – | – |

All are loaded with separate dynamic `import()`s, so a bundler emits separate chunks and a JPEG→WebP job never
downloads the 3.5 MB AVIF encoder. Rejected: **libimagequant** (pngquant) — GPL-3.0/commercial, incompatible with
permissive distribution; **JPEG XL** — no shipping browser decodes it by default except Safari, so outputs would not
be displayable; **jpegtran** lossless JPEG transcoding — not available in the jSquash builds (next step).

### Why no custom Rust crate (yet)

The performance-critical work is in the codecs, which are already mature C/Rust code compiled to WASM (three of the
six modules are Rust). Our own TypeScript is container parsing (byte-level, cheap), the classifier (samples ≤150 K
pixels), and SSIM. SSIM is the only hot loop we own; the benchmark measures its cost implicitly in `timeMs`. A Rust
SSIM would be the first candidate for a custom WASM module, but no Rust toolchain was available in the build
environment and adding an unbuilt, untested crate would violate the “working and measured” rule. See next steps.

## Workers, memory, cancellation

- Expensive work always runs in a module Web Worker (`new Worker(new URL("./worker.js", import.meta.url), {type: "module"})`),
  which Vite, webpack 5 and Parcel bundle natively. `workerFactory` overrides it.
- The input `Blob` is posted to the worker (structured clone by reference, no copy on the main thread); the output
  `ArrayBuffer` is **transferred** back.
- Pool size defaults to `min(2, cores − 1)`; each job holds the decoded image a few times (reference, candidate
  decode, codec heap), so more concurrency mostly adds memory pressure.
- **Cancellation** terminates the worker: a running WASM encode cannot be interrupted any other way. Queued jobs are
  dropped. Browser test: abort latency 0 ms on a 12 MP job.
- **WASM memory never shrinks.** Workers are terminated after jobs above 8 MP (`recycleAfterPixels`) and after 30 s idle.
- `SharedArrayBuffer`/cross-origin isolation are not required. When the page *is* cross-origin isolated, jSquash
  selects its multi-threaded AVIF encoder and oxipng builds; that configuration is **not** benchmarked or tested here.

## Fallbacks

`codecs/fallback.ts` wraps the WASM backend: if an operation throws (e.g. CSP without `'wasm-unsafe-eval'` blocks
WebAssembly), it is retried on the OffscreenCanvas backend and recorded in `result.fallbacks`. If a format has no
working encoder at all (canvas cannot encode AVIF in Chromium), that format is skipped with a warning and the search
continues. With `codecFallback: "none"`, nothing falls back. Without Worker support, the default is to fail with
`UNSUPPORTED_ENVIRONMENT`; `allowMainThread: true` runs on the main thread and reports it.

Canvas fallback caveats: premultiplied alpha (semi-transparent pixels may not round-trip, so lossless verification
can fail and the original is returned), no lossless WebP, no encoder tuning.

## Formats

| Format | Input | Output | Notes |
|---|---|---|---|
| JPEG | ✓ (8-bit YCbCr/gray) | ✓ MozJPEG | CMYK/12-bit: original kept |
| PNG (incl. 16-bit) | ✓ | ✓ oxipng | APNG: container-level only |
| WebP (lossy/lossless/animated) | ✓ | ✓ | animated: container-level only, or first frame with `preserveAnimation: false` |
| AVIF | ✓ still | ✓ | animated / `irot` / `imir`: original kept |
| GIF | ✓ (own decoder) | – | animated: original kept; static: converted |
| HEIC/HEIF | recognised | – | `UNSUPPORTED_FORMAT`: no reliable, licence-compatible WASM decoder (libheif is LGPL, HEVC is patent-encumbered); Safari-only native decode would make results browser-dependent |
| SVG | recognised | passthrough | never rasterised or rewritten |

## Security

- Inputs are untrusted: format from bytes, bounds-checked parsers, size/pixel limits before decoding, capped
  decompression of ICC data, decoders run in WASM sandboxes inside a worker.
- No network access besides loading the library's own WASM files; nothing is logged; image bytes and metadata never
  appear in errors (codec messages only).
- Default `preserveMetadata: true` keeps EXIF (which may include GPS location). Set `preserveMetadata: false` to
  remove EXIF/XMP/comments; colour profiles that change appearance are kept even then.
- The upload helper only talks to the URL your backend presigned; no AWS credentials in browser code.
