# Performance and correctness audit

An independent pass over Optiq looking for outputs larger than the input, quality loss, lost metadata and
WebAssembly overhead. Every number on this page comes from a script in `bench/audit/` and its output file in
`bench/results/`. Lossless semantics were not changed to save bytes.

## Method

- **Fixtures:** 17 edge cases generated deterministically from the benchmark corpus — a 12 MP phone JPEG with
  EXIF orientation 6, Display P3 profile, GPS and 4 KB XMP; sRGB+EXIF JPEG; P3 PNG photo; grayscale JPEG; an
  already-compressed q55 JPEG; palette PNG with alpha; 16-bit PNG; PNG with `gAMA`; 16×16 icon; lossy and lossless
  WebP; static and animated GIF; CMYK JPEG; AVIF; screenshot; transparent icon.
- **Variants:** `lossless`, `lossless` + strip metadata, `visually-lossless`, `balanced`, `balanced` + strip,
  `balanced` + `maxWidthOrHeight: 1024`, `balanced` + `targetFormat: "webp"` — 119 runs.
- **Independent checks** (no Optiq code involved):
  lossless claims → decode input and output with libvips and compare raw pixels (16-bit for 16-bit input);
  quality → `ssim.js` reference SSIM and PSNR; metadata → `sharp.metadata()` of the output (EXIF, GPS IFD,
  ICC bytes, XMP, orientation, frame count).
- **Profiling:** wall time per pipeline phase through the engine's `onTiming` hook; codec microbenchmarks WASM vs
  native libvips with identical settings.

Reproduce: `pnpm bench:corpus && pnpm build && node bench/audit/run.mjs && node bench/audit/codecs.mjs`.

## Findings

| # | Finding | Evidence | Action |
|---|---|---|---|
| 1 | **`visually-lossless` returned the 794 KB original of a P3 photo PNG, while `lossless` mode found a 472 KB pixel-exact WebP.** JPEG/WebP were capped at q95 (SSIM 0.9847 / 0.9898 < 0.99), AVIF is excluded for P3, and lossless candidates were never tried for photos. | `bench/results/audit-before-fixes.json` | Quality ceilings raised to JPEG 98 / WebP 99 / AVIF 95; lossless candidates are added when no re-encode passes and the input is stored losslessly. Now 794 KB → **171 KB** (WebP, SSIM 0.9925; reference SSIM 0.998). Regression test added. |
| 2 | **Alpha errors were under-penalised.** Composited SSIM gave an icon 0.994 while the alpha plane alone scored 0.972; AVIF alpha errors reached 128/255 at shape edges. | `bench/audit/alpha-metric.mjs`, `avif-alpha.mjs` | Score is now `min(composited, alpha-plane SSIM)`. Costs bytes where alpha was being degraded (see below). |
| 3 | Output larger than the input: lossless WebP screenshot + `maxWidthOrHeight: 1024` → 24 KB in, 55 KB out. Resampling destroys flat colours (lossless WebP of the resized image: 159 KB). | audit run | Correct under the caller's constraint; the result now carries an explicit warning. |
| 4 | Before the audit, libvips AVIF beat ours on one transparent illustration (19.1 KB at SSIM 0.9938 vs 20.0 KB at 0.9910). | `bench/results/RESULTS.md` | **Not changed.** Our alpha-quality boost costs those bytes: at q30–45 without it, the maximum alpha error outside transparent areas rose from 35–73 to 69–142 levels, and the icon showed alpha haze up to 65 in fully transparent areas (26 with the boost) (`avif-alpha.mjs`). |
| 5 | libvips lossless WebP (effort 6) up to 3% smaller. | `codecs.mjs` | **Not changed.** Method 6 (quality 100) saves 0.9–2.8% but is 31–37× slower (0.95 s on a 1 MP screenshot, 6.1 s on a 0.4 MP photo). |
| 6 | 4:2:0 vs 4:4:4 AVIF for graphics | `avif-settings.mjs` | **Kept 4:4:4.** Mixed per image: at SSIM 0.975, 4:2:0 was 23% smaller on the code screenshot but 4:4:4 was 13% smaller on the text page; at 0.99, 4:4:4 was 20% smaller on the text page and 4:2:0 could not reach 0.99 on the code screenshot at all. Summed over the 7 graphics images 4:4:4 is 4% smaller at 0.975. No single setting wins everywhere; trying both would add AVIF encodes, the most expensive step. |
| 7 | **SSIM was too lenient on AVIF** (found 2026-10-29). Scored with the independent SSIMULACRA2, `balanced` outputs had a median of 73.9, below WebP q80 (78.6), although all passed SSIM 0.975. At equal SSIM, AVIF scored 3–5 points lower than WebP on the same images, and up to 17 lower on screenshots and text. So "24/24 meet the threshold" was an artefact of the metric. | `bench/ssimulacra2.mjs`, `bench/calibrate-s2.mjs`, `bench/results/ssimulacra2.json` | AVIF threshold is now `1 − k·(1 − T)`, with k = 0.7 for photos and 0.3 otherwise. k was fitted on the corpus and checked on 91 held-out images. `balanced`: median 79.4 (WebP q80 78.6) at +2.7% bytes, 19% smaller than WebP q80. The README claim was corrected. |

No metadata problems were found: EXIF and XMP were kept whenever `preserveMetadata` was on (AVIF is skipped rather
than losing them), GPS was removed in every strip run, non-sRGB ICC profiles were never dropped, orientation was
baked or kept as reported, animation was never flattened, and every lossless output was pixel-identical when
decoded by libvips — including the 16-bit PNG at 16-bit depth.

## Where the time goes

All 119 audit runs, by phase (after fixes):

| Phase | Share |
|---|---|
| encode (WASM codecs) | 79.8% |
| SSIM (JS) | 9.7% |
| verify-decode (WASM) | 6.8% |
| resize, decode, classify, orientation, compare, probe, container | 3.7% combined |

WASM vs native libvips, same settings, single thread, median:

| Image | Operation | WASM / JS | Native | |
|---|---|---|---|---|
| kodim23 (0.4 MP) | decode jpeg | 2.2 ms | 1.3 ms | 1.65×  |
| kodim23 (0.4 MP) | encode jpeg q80 (mozjpeg) | 34.2 ms | 15.8 ms | 2.17×  |
| kodim23 (0.4 MP) | encode webp q80 m4 | 25.1 ms | 18.8 ms | 1.34×  |
| kodim23 (0.4 MP) | encode avif q50 speed6 | 193.3 ms | 77.5 ms | 2.49× native effort 3 ≈ libaom speed 6 |
| kodim23 (0.4 MP) | encode webp lossless m4 q75 | 172.0 ms | – |  345944 B |
| kodim23 (0.4 MP) | encode webp lossless m5 q75 | 174.8 ms | – |  345944 B |
| kodim23 (0.4 MP) | encode webp lossless m6 q100 | 6234.9 ms | – |  342876 B |
| kodim23 (0.4 MP) | encode png oxipng level 2 | 311.4 ms | – |  456173 B |
| kodim23 (0.4 MP) | encode png oxipng level 3 | 800.9 ms | – |  443547 B |
| kodim23 (0.4 MP) | ssim (JS) | 5.9 ms | – |   |
| kodim23 (0.4 MP) | exact compare (JS) | 0.0 ms | – |   |
| kodim23 (0.4 MP) | classify (JS) | 7.8 ms | – |   |
| kodim23 (0.4 MP) | RGBA copy (slice) | 0.1 ms | – |  cost of one extra buffer copy |
| screenshot (1 MP) | decode png | 6.2 ms | 3.6 ms | 1.71×  |
| screenshot (1 MP) | encode jpeg q80 (mozjpeg) | 88.4 ms | 41.9 ms | 2.11×  |
| screenshot (1 MP) | encode webp q80 m4 | 47.9 ms | 33.8 ms | 1.42×  |
| screenshot (1 MP) | encode avif q50 speed6 | 298.6 ms | 215.7 ms | 1.38× native effort 3 ≈ libaom speed 6 |
| screenshot (1 MP) | encode webp lossless m4 q75 | 30.8 ms | – |  24372 B |
| screenshot (1 MP) | encode webp lossless m5 q75 | 42.4 ms | – |  24372 B |
| screenshot (1 MP) | encode webp lossless m6 q100 | 949.8 ms | – |  23678 B |
| screenshot (1 MP) | encode png oxipng level 2 | 313.4 ms | – |  140516 B |
| screenshot (1 MP) | encode png oxipng level 3 | 966.0 ms | – |  140516 B |
| screenshot (1 MP) | ssim (JS) | 15.3 ms | – |   |
| screenshot (1 MP) | exact compare (JS) | 0.1 ms | – |   |
| screenshot (1 MP) | classify (JS) | 4.2 ms | – |   |
| screenshot (1 MP) | RGBA copy (slice) | 0.3 ms | – |  cost of one extra buffer copy |
| phone (12 MP) | decode jpeg | 61.9 ms | 57.6 ms | 1.07×  |
| phone (12 MP) | encode jpeg q80 (mozjpeg) | 1178.5 ms | 575.1 ms | 2.05×  |
| phone (12 MP) | encode webp q80 m4 | 811.4 ms | 598.8 ms | 1.35×  |
| phone (12 MP) | ssim (JS) | 184.3 ms | – |   |
| phone (12 MP) | exact compare (JS) | 0.0 ms | – |   |
| phone (12 MP) | classify (JS) | 5.9 ms | – |   |
| phone (12 MP) | RGBA copy (slice) | 3.5 ms | – |  cost of one extra buffer copy |
| phone (12 MP) | tile mosaic (JS) | 2.3 ms | – |   |

Interpretation: the WASM codecs cost 1.1–2.5× native time (MozJPEG ~2.1×: the jSquash build has no SIMD). That is
the price of running in the browser and cannot be removed without rebuilding the codecs. Buffer copies (3 ms at
12 MP), classification (≤ 8 ms) and module initialisation (40 ms in Node) are negligible. SSIM was the only
overhead owned by Optiq that mattered: it cost ~25% of each candidate on small photos.

**Optimisation applied:** SSIM windows are 8 rows tall at stride 4, so every pixel was converted and accumulated
twice. Partial sums are now kept per 4-row group. Results are numerically identical (test, |Δ| < 1e-10) and SSIM is
20–54% faster (12.7 → 5.9 ms at 0.4 MP, 19.7 → 15.3 ms at 1 MP, 231 → 184 ms at 12 MP). End-to-end time did not
drop because fixes 1 and 2 add work (wider quality range, alpha-plane SSIM).

## Before / after on the benchmark corpus (Node)

| Tool | Images | Bytes before → after | Changed outputs | Time before → after (sum) | Min SSIM before → after |
|---|---|---|---|---|---|
| `sc-balanced` | 24 | 5.152 → 5.148 MB (-0.1%) | 2 | 68.2 → 70.0 s (3%) | 0.9752 → 0.9751 |
| `sc-balanced-nometa` | 24 | 4.450 → 4.446 MB (-0.1%) | 2 | 88.4 → 89.0 s (1%) | 0.9753 → 0.9751 |
| `sc-visually-lossless` | 24 | 6.383 → 6.407 MB (0.4%) | 10 | 108.0 → 109.1 s (1%) | 0.9902 → 0.9902 |
| `sc-lossless` | 24 | 10.553 → 10.553 MB (0.0%) | 0 | 18.6 → 19.0 s (2%) | 1.0000 → 1.0000 |

Changed outputs:

| Image | Tool | Bytes before → after | SSIM before → after | Format before → after |
|---|---|---|---|---|
| photo-kodim03.jpg | sc-visually-lossless | 56948 → 53589 (-5.9%) | 0.9919 → 0.9908 | avif → avif |
| photo-kodim07.jpg | sc-visually-lossless | 53730 → 56370 (4.9%) | 0.9903 → 0.9910 | avif → avif |
| photo-kodim15.jpg | sc-visually-lossless | 72941 → 69356 (-4.9%) | 0.9917 → 0.9904 | avif → avif |
| photo-kodim20.jpg | sc-visually-lossless | 48756 → 51201 (5.0%) | 0.9906 → 0.9913 | avif → avif |
| photo-kodim23.jpg | sc-visually-lossless | 53956 → 58731 (8.8%) | 0.9902 → 0.9917 | avif → avif |
| photo-kodim19.png | sc-balanced | 74670 → 70744 (-5.3%) | 0.9772 → 0.9758 | avif → avif |
| photo-kodim19.png | sc-balanced-nometa | 74670 → 70744 (-5.3%) | 0.9772 → 0.9758 | avif → avif |
| photo-kodim19.png | sc-visually-lossless | 141333 → 157150 (11.2%) | 0.9913 → 0.9927 | avif → avif |
| transparent-illustration-1.png | sc-visually-lossless | 14366 → 15701 (9.3%) | 0.9902 → 0.9907 | avif → avif |
| transparent-illustration-2.png | sc-visually-lossless | 19979 → 21801 (9.1%) | 0.9910 → 0.9913 | avif → avif |
| transparent-illustration-3.png | sc-visually-lossless | 14286 → 16193 (13.3%) | 0.9910 → 0.9911 | avif → avif |
| transparent-icon.png | sc-balanced | 2035 → 2147 (5.5%) | 0.9953 → 0.9824 | avif → avif |
| transparent-icon.png | sc-balanced-nometa | 2035 → 2147 (5.5%) | 0.9953 → 0.9824 | avif → avif |
| transparent-icon.png | sc-visually-lossless | 2210 → 2836 (28.3%) | 0.9972 → 0.9930 | avif → avif |


Trade-offs, stated plainly: `visually-lossless` grew 0.4% overall. Transparent images grew 5–28% because their alpha
channel is no longer allowed to degrade (finding 2). Kodak photos moved ±5–9% in both directions because the wider
quality range changes the bisection path; all still meet SSIM ≥ 0.99. `lossless` output is unchanged byte for byte.

## Not covered

- Firefox and Safari for the audit itself (the audit runs in Node; the browser test suite covers Chromium, Firefox and WebKit).
- Peak memory in the browser (measured in Node only, see benchmarks).
- Perceptual metrics beyond SSIM/PSNR (Butteraugli, SSIMULACRA2).
