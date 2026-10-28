# Modes and quality

| Mode | Constraint | Pixels | Default budget | AVIF preset |
|---|---|---|---|---|
| `lossless` | decoded RGBA identical to the input | unchanged (verified) | 4 encodes | not used |
| `visually-lossless` | SSIM ≥ 0.99 | may differ | 16 encodes | speed 6 |
| `balanced` (default) | SSIM ≥ 0.975 | may differ | 10 encodes | speed 7 |
| `fast` | SSIM ≥ 0.975 | may differ | 5 encodes | not used (no AVIF, no oxipng) |

Perceptual modes never claim to be lossless: the result reports `qualityMetricName: "ssim"` and the measured
`qualityMetric`.

## Which one?

- **User photos for a feed or profile** — `balanced`, optionally with `maxWidthOrHeight`.
- **Phones, batches of many photos, slow networks** — `fast`: same quality bar, about 3.5× faster and ~40% less
  memory than `balanced` in the benchmark (its search starts from a [predicted quality](/architecture#quality-predictor-search-start)), at the cost of larger files (no AVIF: transparent illustrations end up
  ~5× larger than with `balanced`).
- **Product images, artwork, anything people zoom into** — `visually-lossless`.
- **Archival, medical, design source files, screenshots used as evidence** — `lossless`.

## How `lossless` works

- PNG input: oxipng re-compresses the original PNG; a lossless WebP is tried as well.
- Screenshots and graphics from any input: lossless PNG and lossless WebP of the decoded pixels.
- JPEG, lossy WebP and AVIF photos: only a **container rewrite** is possible (removing metadata with
  `preserveMetadata: false`); decoded pixels of a lossy file are never re-encoded losslessly because the result is
  almost always larger. JPEG→JPEG lossless transcoding (jpegtran) is not available in this build.
- Every re-encoded candidate is decoded and compared pixel by pixel; a mismatch rejects it.
- Resizing is refused unless `allowLossyResize: true`.

“Lossless” refers to the decoder Optiq uses. Different JPEG decoders do not produce bit-identical pixels,
which is one more reason JPEG inputs are only ever rewritten at container level.

## The quality metric

SSIM with uniform 8×8 windows at stride 4, on BT.601 Y, Cb and Cr, weighted 6:1:1:

- **Alpha:** pixels are composited on black and on white and the worse score is used, so colour hidden under fully
  transparent pixels does not matter. Compositing under-penalises alpha errors, so the score is additionally capped
  by the SSIM of the alpha plane alone (added after the [audit](/audit) found an icon scoring 0.994 composited but
  0.972 on alpha).
- **Active-window pooling:** windows that are perfectly flat and identical in both images are excluded. Without
  this, large untouched backgrounds hide artifacts around text and edges.
- **Gradients** are held to a stricter threshold (half-way to 1) because banding appears before SSIM drops.
- **Large images (> 4 MP):** the quality search runs on a 3×3 mosaic of full-resolution 512 px tiles; the winning
  encoder is then run on the full image and verified there.

Validated against the `ssim.js` reference implementation: luma SSIM agreed within 0.002.

::: warning SSIM is a proxy
SSIM is not a perceptual model of colour or banding. It under-weights chroma bleeding around coloured text and
banding in smooth gradients. Check the thresholds on your own content; `minQuality` is configurable.
:::

## Search

Per lossy format, quality is bisected between the highest failing and lowest passing setting, starting from a
mode-specific prior, until the gap is within 5 (balanced) or 3 (visually-lossless) quality steps. Ranges reach JPEG
98, WebP 99 and AVIF 95. If no re-encode meets the threshold and the input is stored losslessly, lossless PNG/WebP
candidates are added, so a perceptual mode never returns more bytes than `lossless` would. A failing encode
that is already larger than the best valid candidate ends that format early. `searchStrategy: "fixed"` encodes each
format once. All encodes count against `maxCandidates`.
