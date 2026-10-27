#!/usr/bin/env node
/**
 * `optiq-image` command line: optimise image files or folders with the same engine as the browser library.
 * Default is a dry run that only reports; pass --out or --in-place to write.
 */
import { mkdir, readdir, stat, writeFile, rename } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { optimizeFiles, type BatchItemResult } from "./batch.js";
import { fileNameFor } from "./client.js";
import type { CompressionMode, OutputFormat, OptiqOptions } from "./types.js";

const HELP = `Usage: optiq-image <files or folders...> [options]

Optimise images with Optiq (the same WASM codecs and quality checks as in the browser).
Without --out or --in-place nothing is written: you get a report (dry run).

Options
  --mode <m>            fast | balanced (default) | visually-lossless | lossless
  --out <dir>           write results to <dir>, mirroring the input folder structure
  --in-place            overwrite inputs (keeps each file's format, so references stay valid)
  --keep-format         never change the format (implied by --in-place)
  --formats <list>      formats auto may choose, e.g. "webp,jpeg" (default: jpeg,png,webp,avif; fast: no avif)
  --max-size <px>       downscale the longest side (in lossless mode this also allows the resize)
  --strip-metadata      remove EXIF (incl. GPS) and XMP
  --min-quality <ssim>  SSIM threshold for perceptual modes (e.g. 0.98)
  --concurrency <n>     worker threads (default: CPU cores - 1)
  --json                print a JSON report instead of a table
  -h, --help            show this help

Examples
  npx optiq-image ./photos --out ./photos-optimized
  npx optiq-image public/images --in-place --mode visually-lossless
  npx optiq-image hero.png --formats webp,avif --out dist/img --json
`;

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);

async function collect(paths: string[]): Promise<{ file: string; root: string }[]> {
  const out: { file: string; root: string }[] = [];
  async function walk(p: string, root: string) {
    const s = await stat(p);
    if (s.isDirectory()) {
      for (const e of await readdir(p)) if (!e.startsWith(".")) await walk(join(p, e), root);
    } else if (IMAGE_EXT.has(extname(p).toLowerCase())) out.push({ file: p, root });
  }
  for (const p of paths) {
    const abs = resolve(p);
    const s = await stat(abs);
    await walk(abs, s.isDirectory() ? abs : dirname(abs));
  }
  return out;
}

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values: a, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      mode: { type: "string" },
      out: { type: "string" },
      "in-place": { type: "boolean" },
      "keep-format": { type: "boolean" },
      formats: { type: "string" },
      "max-size": { type: "string" },
      "strip-metadata": { type: "boolean" },
      "min-quality": { type: "string" },
      concurrency: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (a.help || !positionals.length) {
    process.stdout.write(HELP);
    return a.help ? 0 : 1;
  }
  if (a.out && a["in-place"]) throw new Error("Use either --out or --in-place, not both");
  const keepFormat = !!(a["keep-format"] || a["in-place"]);
  const maxSize = a["max-size"] ? Number(a["max-size"]) : undefined;
  const options: OptiqOptions = {
    mode: (a.mode as CompressionMode | undefined) ?? "balanced",
    allowFormatConversion: !keepFormat,
    autoFormats: a.formats ? (a.formats.split(",").map((s) => s.trim()) as OutputFormat[]) : undefined,
    maxWidthOrHeight: maxSize,
    allowLossyResize: maxSize !== undefined,
    preserveMetadata: !a["strip-metadata"],
    minQuality: a["min-quality"] ? Number(a["min-quality"]) : undefined,
  };
  const files = await collect(positionals);
  if (!files.length) {
    process.stderr.write("No images found (jpg, jpeg, png, webp, avif, gif)\n");
    return 1;
  }
  const t0 = performance.now();
  const results = await optimizeFiles(
    files.map((f) => f.file),
    options,
    {
      concurrency: a.concurrency ? Number(a.concurrency) : undefined,
      onResult: a.json || !process.stderr.isTTY ? undefined : (r, done, total) => process.stderr.write(`\r${done}/${total} ${relative(process.cwd(), r.path)}`.padEnd(80).slice(0, 100)),
    },
  );
  if (!a.json && process.stderr.isTTY) process.stderr.write("\r".padEnd(101) + "\r");

  const rows: Record<string, unknown>[] = [];
  let before = 0, after = 0, errors = 0;
  for (let i = 0; i < results.length; i++) {
    const r: BatchItemResult = results[i];
    const { file, root } = files[i];
    const rel = relative(root, file);
    if (r.error || !r.report) {
      errors++;
      rows.push({ file: relative(process.cwd(), file), error: `${r.error?.code ?? "ERROR"}: ${r.error?.message}` });
      continue;
    }
    const rep = r.report;
    before += rep.originalBytes;
    after += rep.outputBytes;
    let written: string | undefined;
    if (r.bytes && (a.out || a["in-place"])) {
      if (a["in-place"]) {
        // Write next to the file, then rename: never leaves a half-written image behind.
        const tmp = `${file}.optiq-tmp`;
        await writeFile(tmp, r.bytes);
        await rename(tmp, file);
        written = file;
      } else {
        const target = join(resolve(a.out!), dirname(rel), fileNameFor(rel.split(/[\\/]/).pop(), rep.outputFormat));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, r.bytes);
        written = target;
      }
    } else if (a.out && !r.bytes) {
      // Already optimal: copy the original so the output folder is complete.
      const { copyFile } = await import("node:fs/promises");
      const target = join(resolve(a.out), rel);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(file, target);
      written = target;
    }
    rows.push({
      file: relative(process.cwd(), file),
      from: rep.originalFormat,
      to: rep.outputFormat,
      before: rep.originalBytes,
      after: rep.outputBytes,
      saved: rep.sizeReductionRatio,
      quality: rep.qualityMetricName === "exact" ? "exact" : rep.qualityMetric,
      usedOriginal: rep.usedOriginal,
      warnings: rep.warnings,
      written: written ? relative(process.cwd(), written) : undefined,
    });
  }
  const seconds = (performance.now() - t0) / 1000;
  if (a.json) {
    process.stdout.write(JSON.stringify({ options, files: rows, totals: { before, after, saved: before ? 1 - after / before : 0, errors, seconds } }, null, 2) + "\n");
  } else {
    for (const r of rows) {
      if (r.error) process.stdout.write(`✗ ${r.file}  ${r.error}\n`);
      else
        process.stdout.write(
          `${r.usedOriginal ? "=" : "✓"} ${String(r.file).padEnd(40)} ${String(r.from).padEnd(4)}→ ${String(r.to).padEnd(4)} ${kb(r.before as number).padStart(9)} → ${kb(r.after as number).padStart(9)}  ${((r.saved as number) * 100).toFixed(1).padStart(5)}%  ${r.quality === "exact" ? "exact" : `SSIM ${(r.quality as number).toFixed(4)}`}\n`,
        );
    }
    process.stdout.write(`\n${results.length} files, ${kb(before)} → ${kb(after)} (${before ? ((1 - after / before) * 100).toFixed(1) : 0}% smaller) in ${seconds.toFixed(1)} s${errors ? `, ${errors} failed` : ""}\n`);
    if (!a.out && !a["in-place"]) process.stdout.write("Dry run: nothing written. Use --out <dir> or --in-place.\n");
  }
  return errors ? 2 : 0;
}

// Run when executed directly (bin), not when imported.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/optiq-image") || process.argv[1]?.endsWith("cli.js")) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`optiq-image: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
