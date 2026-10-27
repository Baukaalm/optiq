# Limitations and FAQ

## Why is it slower than `canvas.toBlob`?

Because it does more: several encodes, a decode and an SSIM computation per candidate. Typical images take
1–4 s, 12 MP photos 3–4 s (8–12 s when AVIF is allowed), a 5 MP screenshot up to ~17 s in `balanced`. A single canvas
encode takes 5–800 ms. If latency matters more than bytes: use `balanced`, lower `maxCandidates`, use
`searchStrategy: "fixed"`, or remove `avif` from `autoFormats`. See the [benchmarks](/benchmarks).

## How much memory does it use?

Median peak ≈ 300 MB per job in the benchmark (Node, same WASM codecs), up to ~1.1 GB for 5 MP screenshots and
12 MP photos with AVIF. WebAssembly memory never shrinks, so workers are terminated after images above 8 MP
(`recycleAfterPixels`) and after 30 s idle. On low-memory mobile devices prefer `maxWidthOrHeight` and fewer formats.

## Why not HEIC?

There is no reliable, licence-compatible decoder for the browser: libheif is LGPL and HEVC is patent-encumbered;
Safari's native decoder would make results browser-dependent. HEIC files fail fast with `UNSUPPORTED_FORMAT`;
upload them as they are or convert them on the server.

## Why not JPEG XL?

Only Safari decodes it by default, so JXL outputs would not be displayable for most users.

## Why not pngquant / lossy PNG?

libimagequant is GPL-3.0 (or commercial), which is incompatible with permissive redistribution.

## Is the SSIM threshold "visually lossless" for everyone?

No. SSIM is a proxy. It is computed the same way for every candidate and validated against a reference
implementation, but it under-weights banding and chroma bleeding. Tune `minQuality` on your own content.

## Does it work in Firefox and Safari?

It uses only standard APIs (module workers, WebAssembly, OffscreenCanvas for the fallback). The automated tests
run in Chromium; Firefox and Safari are not covered yet.

## Does anything get uploaded or logged?

No. The library fetches only its own JS/WASM files. Image data stays in the page until your code uploads it.
