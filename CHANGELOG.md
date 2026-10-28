# Changelog

## 0.3.0-beta.0 (2026-10-28)

- `fast` mode starts each codec's quality search from a prediction (ridge regression on cheap image features,
  fitted on a 317-image corpus in `bench/predictor/`). Benchmark: −8.0% bytes and −18% time vs the fixed start;
  quality still verified for every output. Not enabled for `balanced`, where it traded size for speed.
- Demo: settings apply to all loaded images immediately; compare and candidates sections expanded by default.

## 0.2.0-beta.0 (2026-10-27)

- `mode: "fast"`: SSIM ≥ 0.975 like `balanced`, no AVIF, no oxipng, ≤ 5 encodes. Benchmark: −54.9% total
  (balanced −61.2%), median 405 ms in Chromium (balanced 1.3 s), median peak RSS 184 MB (balanced 304 MB).
- `optiq-image` CLI (`npx optiq-image <files|folders>`): dry run by default, `--out`, `--in-place`, parallel workers.
- `optiq-image/vite`: Vite plugin that optimises build output in place (same names and formats).
- `optiq-image/react`: `useOptiq(file, options)` hook.
- `optimizeFiles()` batch API for Node (worker_threads pool).

## 0.1.0-beta.0 (2026-10-27)

Audit fixes (see docs/audit.md):

- A perceptual mode could return the original although `lossless` mode found a smaller pixel-exact file (P3 photo
  PNG: 794 KB returned, 472 KB available). Quality ranges now reach JPEG 98 / WebP 99 / AVIF 95, and lossless
  candidates are added when no re-encode meets the threshold for a losslessly stored input.
- SSIM is now bounded by the alpha plane's own SSIM for images with transparency.
- Warning when the output is larger than the input because the original was not an allowed result.
- SSIM 20–54% faster with numerically identical results.
- Verified with Vite 7 and Vite 8.

First public beta.

- `compressImage` / `createCompressor`: Web Worker pool, `AbortSignal` cancellation (terminates the worker),
  progress events, typed `OptiqError` codes, canvas fallback when WASM cannot load.
- Modes: `lossless` (pixel-exact, verified), `visually-lossless` (SSIM ≥ 0.99), `balanced` (SSIM ≥ 0.975).
- Codecs (via jSquash): MozJPEG, libwebp, libavif, oxipng, Rust `png` and `resize`; own static-GIF decoder.
- Format sniffing from content; EXIF orientation, ICC, EXIF/XMP preservation; animation never silently flattened.
- Tile-mosaic quality search for images above 4 MP.
- `optiq-image/upload`: presigned PUT/POST upload with progress and original-file fallback.
- `optiq-image/node`: Node.js codec initialisation for tests, benchmarks and server-side use.

Tested in Chromium, Firefox and WebKit. Known limitations: no AVIF metadata writer; HEIC unsupported.
