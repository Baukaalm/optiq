/**
 * `optiq-image/vite` — optimise the images in your Vite build output (bundled assets and `public/` files).
 *
 * Runs after the bundle is written. Every image keeps its file name and format, so references in HTML, CSS and JS
 * stay valid; a file is only replaced when the result is smaller and meets the quality constraint.
 *
 * @packageDocumentation
 */
import { readdir, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";
import { optimizeFiles } from "./batch.js";
import type { CompressionMode } from "./types.js";

export interface OptiqViteOptions {
  /** Default `visually-lossless` (SSIM ≥ 0.99, same format). PNG/GIF are only ever optimised losslessly here. */
  mode?: CompressionMode;
  /** Only files whose path (relative to outDir) matches. Default: all jpg/jpeg/png/webp/avif. */
  include?: RegExp;
  exclude?: RegExp;
  /** Keep EXIF/XMP. Default `false` for build output (strips GPS etc. from published images). */
  preserveMetadata?: boolean;
  /** Worker threads. Default: CPU cores − 1. */
  concurrency?: number;
  /** Print a per-file report. Default `true`. */
  verbose?: boolean;
}

const EXT = /\.(jpe?g|png|webp|avif)$/i;

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir)) {
    const p = join(dir, e);
    if ((await stat(p)).isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

export function optiq(options: OptiqViteOptions = {}): Plugin {
  let config: ResolvedConfig;
  return {
    name: "optiq-image",
    apply: "build",
    enforce: "post",
    configResolved(c) {
      config = c;
    },
    async closeBundle() {
      const outDir = resolve(config.root, config.build.outDir);
      const files = (await walk(outDir)).filter((f) => {
        const rel = relative(outDir, f);
        return (options.include ?? EXT).test(rel) && EXT.test(extname(f)) && !(options.exclude && options.exclude.test(rel));
      });
      if (!files.length) return;
      const t0 = performance.now();
      const results = await optimizeFiles(
        files,
        {
          mode: options.mode ?? "visually-lossless",
          targetFormat: "original",
          allowFormatConversion: false,
          preserveMetadata: options.preserveMetadata ?? false,
        },
        { concurrency: options.concurrency },
      );
      let before = 0;
      let after = 0;
      for (const r of results) {
        const rel = relative(outDir, r.path);
        if (r.error || !r.report) {
          config.logger.warn(`[optiq] ${rel}: ${r.error?.code ?? "error"} ${r.error?.message ?? ""} (left unchanged)`);
          continue;
        }
        before += r.report.originalBytes;
        after += r.report.outputBytes;
        if (r.bytes) await writeFile(r.path, r.bytes);
        if (options.verbose !== false && r.bytes) {
          const q = r.report.qualityMetricName === "exact" ? "lossless" : `SSIM ${r.report.qualityMetric?.toFixed(4)}`;
          config.logger.info(`[optiq] ${rel}  ${r.report.originalBytes} → ${r.report.outputBytes} B (−${(r.report.sizeReductionRatio * 100).toFixed(1)}%, ${q})`);
        }
      }
      config.logger.info(
        `[optiq] ${files.length} images: ${(before / 1024).toFixed(1)} KB → ${(after / 1024).toFixed(1)} KB ` +
          `(−${before ? ((1 - after / before) * 100).toFixed(1) : 0}%) in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
      );
    },
  };
}

export default optiq;
