# Options and results

## Options

| Option | Default | Meaning |
|---|---|---|
| `mode` | `"balanced"` | `lossless`, `visually-lossless`, `balanced`, `fast` |
| `minQuality` | 0.99 / 0.975 | SSIM threshold for perceptual modes |
| `maxOutputBytes` | – | Upper bound; reported in `unmetConstraints` when it cannot be met without violating quality |
| `maxWidthOrHeight` | – | Downscale the longest side (Lanczos3, linear light, premultiplied alpha) |
| `allowLossyResize` | `false` | Permit resizing in `lossless` mode |
| `targetFormat` | `"auto"` | `auto`, `original`, `jpeg`, `png`, `webp`, `avif` |
| `autoFormats` | all four (`fast`: no AVIF) | Formats `auto` may choose |
| `allowFormatConversion` | `true` | `false` keeps the input format |
| `maxCandidates` | 10 / 16 / 4 / 5 | Encode budget (balanced / visually-lossless / lossless / fast) |
| `searchStrategy` | `"binary"` | `fixed`: one encode per format |
| `preserveMetadata` | `true` | Keep EXIF/XMP/ICC; `false` removes EXIF (incl. GPS) and XMP |
| `preserveAnimation` | `true` | `false` permits flattening animations to the first frame |
| `minSavingsRatio` | `0.02` | Return the original unless re-encoding saves at least this share |
| `maxInputBytes` | 100 MiB | Checked before the file is read |
| `maxInputPixels` | 50 MP | Checked from the header before decoding |
| `onUnmetConstraints` | `"best-effort"` | `throw` rejects with `CONSTRAINTS_UNSATISFIABLE` |
| `signal` | – | `AbortSignal` |
| `onProgress` | – | Progress callback |

Options are constraints, not promises. When they conflict with the image (JPEG requested for a transparent
image, conversion of an animated GIF, resizing in lossless mode) the call fails with `INCOMPATIBLE_OPTIONS` and a
message that says which option to change.

## Result

| Field | |
|---|---|
| `blob`, `fileName`, `mimeType` | Output ready to upload; type and extension match the bytes |
| `usedOriginal` | `true` when `blob` is the unmodified input |
| `originalFormat`, `outputFormat` | Detected from content |
| `originalBytes`, `outputBytes`, `sizeReductionRatio` | `1 − out/in`. Can be negative only when the original is not an allowed result (explicit `targetFormat`, or resizing) |
| `width`, `height`, `originalWidth`, `originalHeight` | As displayed (after EXIF orientation) |
| `qualityMetric`, `qualityMetricName` | SSIM, or `1` with `"exact"` |
| `codec`, `settings` | Encoder and settings of the chosen candidate |
| `category` | `photo`, `screenshot`, `text-graphic`, `illustration`, `transparent-illustration`, `gradient` |
| `candidates` | Every encode tried (size, quality, time, pass/fail; `proxy: true` for tile-mosaic search) |
| `constraintsMet`, `unmetConstraints` | Which constraints could not be met |
| `metadata` | What happened to EXIF, XMP, ICC and orientation |
| `fallbacks` | Codec or runtime fallbacks used |
| `warnings` | Human-readable notes, e.g. “AVIF output skipped: …” |
| `durationMs`, `mode` | |

## Progress

`onProgress` receives `{ stage, progress, candidatesTried, candidateBudget, bestBytes? }`.
Stages, in order: `reading → probing → decoding → (resizing) → analyzing → encoding → finalizing → done`.
`progress` is a rough 0..1 value; `bestBytes` is the smallest valid candidate so far — useful for an
“estimated reduction” display while the search runs.
