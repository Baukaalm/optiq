# Formats, metadata, colour

Formats are detected from the bytes. File extensions and MIME types are ignored — a `.jpg` that contains a PNG is
treated as PNG, and the result's `mimeType`/`fileName` are corrected.

| Format | Input | Output | Notes |
|---|---|---|---|
| JPEG | 8-bit RGB / grayscale | jpegli, progressive | CMYK and 12-bit JPEG are returned unchanged |
| PNG | all, including 16-bit | oxipng (lossless) | APNG: container-level only |
| WebP | lossy, lossless, animated | lossy / lossless | animated: container-level only |
| AVIF | still images | libavif | animated or rotated (`irot`/`imir`) AVIF returned unchanged |
| GIF | static and animated | – | static GIFs are converted; animated ones kept |
| HEIC / HEIF | recognised | – | `UNSUPPORTED_FORMAT` (see FAQ) |
| SVG | recognised | – | returned unchanged, never rasterised |

## Transparency

JPEG is never chosen for an image with any pixel whose alpha is below 255 (checked on decoded pixels, so a PNG
with an all-opaque alpha channel may still become JPEG). Asking for `targetFormat: "jpeg"` on a transparent image
fails with `INCOMPATIBLE_OPTIONS`.

## Orientation

EXIF orientation is applied to the pixels of re-encoded outputs and the tag is reset to 1, so every viewer shows
the image the same way. Container-level outputs keep the original tag (when metadata is stripped, a 26-byte EXIF
block with only the orientation is kept).

## Colour profiles

- ICC profiles are carried into JPEG (APP2), PNG (`iCCP`) and WebP (`ICCP`) outputs.
- AVIF output is tagged sRGB through its `nclx` colour box. Images with a non-sRGB profile (Display P3,
  Adobe RGB …) are therefore never converted to AVIF; requesting it fails with `INCOMPATIBLE_OPTIONS`.
- An sRGB profile is removed only with `preserveMetadata: false` (or for AVIF output, where the sRGB tag is
  equivalent). No colour conversion is ever performed.
- PNG `gAMA`/`cHRM` chunks are only preserved in PNG output; a warning says so.

## Metadata

`preserveMetadata: true` (default) keeps EXIF and XMP in JPEG, PNG and WebP outputs. AVIF output is skipped in
that case because Optiq cannot write AVIF metadata yet; the warning says so. When the image is resized,
EXIF pixel-dimension tags may still describe the original size.

`preserveMetadata: false` removes EXIF (including GPS location), XMP, comments and trailing data such as embedded
thumbnails or vendor trailers. This is a privacy feature as well as a size one; colour profiles that change
appearance are kept.

`result.metadata` reports what happened: `exif` / `xmp` ∈ `kept | removed | none`,
`iccProfile` ∈ `kept | dropped-srgb | none`, `orientation` ∈ `kept | baked | none`.

## Animation

With `preserveAnimation: true` (default) animated GIF, APNG and animated WebP are optimised at container level only
(metadata removal), and conversion to another format fails with `INCOMPATIBLE_OPTIONS`. With
`preserveAnimation: false` the first frame may be encoded as a still image, and a warning says so.
