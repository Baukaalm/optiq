# Changelog

## 0.1.0-beta.0 (unreleased)

First public beta.

- `compressImage` / `createCompressor`: Web Worker pool, `AbortSignal` cancellation (terminates the worker),
  progress events, typed `SmartCompressError` codes, canvas fallback when WASM cannot load.
- Modes: `lossless` (pixel-exact, verified), `visually-lossless` (SSIM ≥ 0.99), `balanced` (SSIM ≥ 0.975).
- Codecs (via jSquash): MozJPEG, libwebp, libavif, oxipng, Rust `png` and `resize`; own static-GIF decoder.
- Format sniffing from content; EXIF orientation, ICC, EXIF/XMP preservation; animation never silently flattened.
- Tile-mosaic quality search for images above 4 MP.
- `smartcompress/upload`: presigned PUT/POST upload with progress and original-file fallback.
- `smartcompress/node`: Node.js codec initialisation for tests, benchmarks and server-side use.

Known limitations: tested in Chromium only; no AVIF metadata writer; HEIC unsupported.
