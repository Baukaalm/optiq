# Static images: CLI and Vite plugin

Optiq is built for user uploads in the browser, but the same engine runs in Node. Two tools use it for images
that live in your project. Both process files in parallel on `worker_threads`, one image per CPU core.

## CLI

```sh
npx optiq-image ./photos                              # dry run: report only, writes nothing
npx optiq-image ./photos --out ./photos-optimized     # write results, mirroring folders
npx optiq-image public/images --in-place              # overwrite, keeping each file's format and name
npx optiq-image hero.png --formats webp,avif --out dist/img --json
```

| Option | |
|---|---|
| `--mode` | `fast`, `balanced` (default), `visually-lossless`, `lossless` |
| `--out <dir>` | Write to a folder. Format may change, so the extension may change (`hero.png` → `hero.webp`) |
| `--in-place` | Overwrite inputs. Implies `--keep-format`, so references in your code stay valid. Files are replaced atomically, only when smaller |
| `--keep-format` | Never change the format |
| `--formats` | Formats `auto` may choose, e.g. `webp,jpeg` |
| `--max-size <px>` | Downscale the longest side |
| `--strip-metadata` | Remove EXIF (incl. GPS) and XMP |
| `--min-quality` | SSIM threshold |
| `--min-saving <ratio>` | Keep a file unless it gets at least this much smaller (default `0.02`) |
| `--reoptimize` | Re-encode files Optiq already compressed lossily (skipped by default, see below) |
| `--no-marker` | Do not tag lossy JPEG/WebP outputs |
| `--concurrency` | Worker threads (default: cores − 1) |
| `--json` | Machine-readable report |

Exit codes: `0` success, `1` usage error, `2` at least one file failed (the others are still processed).

Measured on 10 corpus images (Apple M4 Pro): 8.9 s with `--concurrency 1`, 1.6 s with the default.

### Running it again is safe

Each lossy pass is checked against *its own input*, so re-compressing an already compressed JPEG passes the SSIM
check again and again while the losses add up. Measured on the 24-image corpus with `--in-place` three times
without protection: the second and third passes shrank 11 JPEGs by another 10–35% each, and after three passes
their SSIM against the true originals had dropped to 0.92–0.95.

So the CLI tags lossy JPEG and WebP outputs with a ~20-byte marker (a JPEG comment / a WebP chunk that decoders
ignore; checked in Chromium, Firefox, WebKit, libvips and macOS ImageIO) and skips re-encoding tagged files. With
the marker, passes two and three changed 0 of 24 files. Lossless outputs need no marker: re-running lossless
optimisation cannot lose anything. AVIF outputs are not tagged yet, so do not re-run lossy optimisation on AVIF
files the tool produced. Resizing (`--max-size`) or `--reoptimize` bypasses the check deliberately.

## Vite plugin

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { optiq } from "optiq-image/vite";

export default defineConfig({
  plugins: [optiq()],
});
```

After `vite build` writes the bundle, the plugin optimises every JPEG, PNG, WebP and AVIF in the output directory —
bundled assets and files copied from `public/` — **in place, keeping each file's name and format**, so URLs in HTML,
CSS and JS stay valid. A file is replaced only when the result is smaller and meets the quality constraint.

| Option | Default | |
|---|---|---|
| `mode` | `"visually-lossless"` | PNG is only ever optimised losslessly (same format) |
| `preserveMetadata` | `false` | Published images lose EXIF/GPS by default |
| `include` / `exclude` | all images | RegExp on the path relative to `outDir` |
| `concurrency` | cores − 1 | |
| `verbose` | `true` | Per-file log lines |

Works with Vite 7 and 8 (build only; the dev server is untouched).

## When to use something else

For static assets the main win is usually a **modern format** (`<picture>` with AVIF/WebP sources) and **responsive
sizes**. The plugin keeps formats so it cannot break references; if you want format conversion, run the CLI with
`--out` and reference the new files, or use a responsive-image tool. `sharp`-based tools are faster (native code)
but do not verify quality per image.
