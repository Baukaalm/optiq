# Changelog

## 0.6.0-beta.0 (unreleased)

- **JPEG is now encoded with jpegli** (Google, from the JPEG XL project) instead of MozJPEG. Optiq builds it to
  WebAssembly itself (`codecs/jpegli/build.sh`, 148 KB, byte-identical to the native `cjpegli`; CI rebuilds and
  verifies it).
  - Photos as JPEG: 7–24% smaller at about the same SSIMULACRA2.
  - Engine time on JPEG: 2–3× faster.
  - Graphics as JPEG: 10–16% larger but higher quality. In `auto` they rarely end up as JPEG.
  - Measured in `bench/jpegli-compare.mjs` and `bench/jpegli-engine.mjs`.
- SSIM thresholds are now per encoder. jpegli photos use k = 1.2 (0.97 in `balanced`), calibrated against
  SSIMULACRA2 like AVIF. A canvas JPEG fallback keeps the plain threshold.
- JPEG decoding still uses libjpeg-turbo from jSquash.
- **SVG is now optimised** with SVGO instead of being passed through, and every result is verified by rendering
  input and output with resvg (WASM).
  - Lossless mode requires a pixel-identical rendering; the other modes require SSIM ≥ 0.995 in `balanced`.
  - The configuration is conservative: ids, `data-*`, `aria-*` and `role` are kept.
  - Text, animation, scripts and external resources get markup-only clean-up.
  - 17 real files: −19.7% in total (SVGO's unchecked default: −20.6%, and it visibly changed one file).
  - The CLI and MCP server now pick up `.svg` files. SVGO is not a sanitiser.
- SVG detection now accepts a DOCTYPE with an internal subset (`<!DOCTYPE svg [ <!ENTITY ...> ]>`, as Illustrator
  writes). Such files were rejected as `UNSUPPORTED_FORMAT` before.

## 0.5.0-beta.0 (2026-10-29)

- **Quality: AVIF is held to a stricter SSIM threshold.** Scoring the benchmark outputs with the independent
  SSIMULACRA2 metric (libjxl) showed that SSIM tolerates AVIF's smoothing. `balanced` had a median SSIMULACRA2 of
  73.9, below WebP q80 (78.6). The AVIF threshold is now `1 − k·(1 − T)`, with k = 0.7 for photos and 0.3 for other
  images. k was fitted against SSIMULACRA2 on the benchmark corpus and checked on 91 held-out images.
  - `balanced`: median 79.4 at +2.7% bytes (−60.1% total, 19% smaller than WebP q80).
  - `visually-lossless`: median 85.8.
  - `fast` is unchanged, since it does not use AVIF.
- Benchmarks now include an SSIMULACRA2 table (`bench/ssimulacra2.mjs`). The README no longer presents
  "24/24 pass SSIM" as a quality comparison.

## 0.4.0-beta.0 (unreleased)

- Generation-loss guard: `markOutput` tags lossy JPEG/WebP outputs with a ~20-byte comment/chunk, and inputs with
  that tag are not re-encoded again in perceptual modes unless `reoptimize: true` (or they are resized). Without it,
  three `--in-place` runs over the benchmark corpus took 11 JPEGs to SSIM 0.92–0.95 against the originals; with it,
  runs two and three change nothing. The CLI enables the tag (`--no-marker`, `--reoptimize`).
- CLI: `--min-saving`; invalid option values fail before any file is processed (exit 1). Interactive terminal
  output ends with a one-line GitHub link (never in `--json`, pipes or CI).
- `optiq-image/node`: `optimizeFilesOnDisk()` and `collectImages()` (what the CLI uses); `optimizeFiles()` accepts
  an `AbortSignal`.
- New package `optiq-mcp` (released separately with `mcp-v*` tags, also listed in the MCP Registry as
  `io.github.Baukaalm/optiq-mcp`): an MCP server with `analyze_images` (read-only) and `optimize_images` tools for AI
  agents. `llms.txt` on the documentation site and an Agent Skill in `skills/optiq/`.

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
