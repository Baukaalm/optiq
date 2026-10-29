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
| SVG | ✓ | SVGO (verified by rendering) | never rasterised; see [SVG](#svg) |

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

## SVG

SVG stays SVG and is never turned into pixels. SVGO rewrites the markup with a conservative configuration:
- `id`s are kept, because CSS, scripts or other files (`<use href="icons.svg#name">`) may reference them;
- `data-*`, `aria-*`, `role`, `viewBox` and legal comments (`<!--! ... -->`) are kept;
- `<metadata>` is kept unless `preserveMetadata: false`.

Every result is checked by rendering both the input and the output with resvg, compiled to WebAssembly. Browsers
cannot rasterise SVG inside a Worker, so the renderer is WASM and behaves the same in Node. The longer side is rendered
at 512 px, so small icons are compared magnified. A result is kept only if:
- in `lossless` mode, the rendering is pixel-identical;
- in the other modes, the rendering's SSIM is within a fifth of the mode's distance to 1 (≥ 0.995 in `balanced`);
- and the file is at least `minSavingsRatio` smaller.

Otherwise the original is returned.

A static render cannot vouch for some things, so files that contain them get **markup-level clean-up only**:
comments, editor data, the XML prolog and whitespace are removed, but numbers, geometry, ids and styles are left
alone. These are:
- text, because the verifying renderer has no fonts;
- animation;
- scripts or event handlers;
- `<foreignObject>`;
- external resources;
- CSS `@import` or `@font-face`.

On 17 real files (Wikimedia Commons logos and illustrations, our own logos), `balanced` saved 19.7% in total, against
20.6% for SVGO's default preset, which runs without any check. That default preset visibly changed one of the files
(rendered SSIM 0.973). Most of the remaining gap is from keeping `id`s.

::: warning SVGO is not a sanitiser
Scripts, event handlers and external references are kept as they are. If you accept SVG uploads and show them
inline or same-origin, sanitise them separately (for example with DOMPurify) or serve them with a restrictive
Content-Security-Policy.
:::

