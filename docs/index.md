---
layout: home
hero:
  name: Optiq
  text: Smaller uploads, measured quality
  tagline: Encodes each image several ways in a Web Worker, measures every result, and keeps the smallest one that meets your lossless or SSIM constraint.
  image:
    light: /logo-black.svg
    dark: /logo-white.svg
    alt: Optiq aperture mark
  actions:
    - theme: brand
      text: Try the demo
      link: /try
    - theme: alt
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Benchmarks
      link: /benchmarks
    - theme: alt
      text: API reference
      link: /api/
features:
  - title: Constraint first
    details: "lossless (pixel-exact, verified), visually-lossless (SSIM ≥ 0.99) or balanced (SSIM ≥ 0.975). Every candidate is decoded and scored; nothing is returned on an estimate."
  - title: Mature codecs in WASM
    details: jpegli (built from source), plus libwebp, libavif, oxipng and Rust resize/png via jSquash. Each codec is a lazy chunk; a JPEG→WebP job never downloads the AVIF encoder.
  - title: Off the main thread
    details: Work runs in module Web Workers. Cancel with AbortSignal (the worker is terminated), follow progress by stage, get typed errors.
  - title: Content-aware
    details: Photos, screenshots, text, transparent illustrations and gradients get different codec orders and settings. Transparency, orientation, colour profiles and animation are never silently dropped.
  - title: Upload-ready
    details: Blob with the right MIME type and file name, plus a presigned-URL upload helper that falls back to the original file.
  - title: Honest numbers
    details: A reproducible benchmark against libvips and browser-image-compression, including where Optiq is slower or larger.
---
