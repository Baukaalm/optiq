# Changelog

## 0.1.0-beta.2 (unreleased)

- Uses optiq-image 0.5.0-beta.0: AVIF is held to a stricter SSIM threshold, calibrated against SSIMULACRA2, so
  `balanced` outputs no longer trade visible quality for bytes on graphics and transparent images.

## 0.1.0-beta.1 (2026-10-29)

- Clearer tool descriptions: when to use `analyze_images` instead of `optimize_images`, how long a run takes,
  how to choose `mode`, `stripMetadata` and `formats`, and more detail on every parameter.

## 0.1.0-beta.0 (2026-10-28)

- First release: `analyze_images` (read-only dry run) and `optimize_images` (in place or to a folder).
