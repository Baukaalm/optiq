#!/usr/bin/env node
/**
 * `optiq-image` command line: optimise image files or folders with the same engine as the browser library.
 * Default is a dry run that only reports; pass --out or --in-place to write.
 */
import { relative } from "node:path";
import { parseArgs } from "node:util";
import { IMAGE_EXTENSIONS, optimizeFilesOnDisk } from "./files.js";
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
  --min-saving <ratio>  keep the original unless the result is at least this much smaller (default 0.02;
                        raise it, e.g. 0.05, when re-running on already optimised files)
  --reoptimize          re-encode files this tool already compressed lossily (by default they are skipped:
                        every lossy pass loses a little more, and the losses add up)
  --no-marker           do not tag lossy JPEG/WebP outputs (~20 bytes) as already optimised
  --concurrency <n>     worker threads (default: CPU cores - 1)
  --json                print a JSON report instead of a table
  -h, --help            show this help

Examples
  npx optiq-image ./photos --out ./photos-optimized
  npx optiq-image public/images --in-place --mode visually-lossless
  npx optiq-image hero.png --formats webp,avif --out dist/img --json
`;

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
const rel = (p: string | undefined) => (p ? relative(process.cwd(), p) : undefined);

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
      "min-saving": { type: "string" },
      reoptimize: { type: "boolean" },
      "no-marker": { type: "boolean" },
      concurrency: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (a.help || !positionals.length) {
    process.stdout.write(HELP);
    return a.help ? 0 : 1;
  }
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
    minSavingsRatio: a["min-saving"] ? Number(a["min-saving"]) : undefined,
    markOutput: !a["no-marker"],
    reoptimize: !!a.reoptimize,
  };
  const progress = !a.json && process.stderr.isTTY;
  const { files, totals } = await optimizeFilesOnDisk(positionals, options, {
    out: a.out,
    inPlace: a["in-place"],
    concurrency: a.concurrency ? Number(a.concurrency) : undefined,
    onResult: progress ? (r, done, total) => process.stderr.write(`\r${done}/${total} ${rel(r.file)}`.padEnd(80).slice(0, 100)) : undefined,
  });
  if (progress) process.stderr.write("\r".padEnd(101) + "\r");
  if (!files.length) {
    process.stderr.write(`No images found (${IMAGE_EXTENSIONS.map((e) => e.slice(1)).join(", ")})\n`);
    return 1;
  }
  const rows = files.map((f) => ({ ...f, file: rel(f.file)!, written: rel(f.written) }));
  if (a.json) {
    process.stdout.write(JSON.stringify({ options, files: rows, totals }, null, 2) + "\n");
  } else {
    for (const r of rows) {
      if (r.error) process.stdout.write(`✗ ${r.file}  ${r.error}\n`);
      else
        process.stdout.write(
          `${r.usedOriginal ? "=" : "✓"} ${r.file.padEnd(40)} ${String(r.from).padEnd(4)}→ ${String(r.to).padEnd(4)} ${kb(r.before!).padStart(9)} → ${kb(r.after!).padStart(9)}  ${(r.saved! * 100).toFixed(1).padStart(5)}%  ${r.quality === "exact" ? "exact" : `SSIM ${r.quality!.toFixed(4)}`}\n`,
        );
    }
    const { before, after, errors, seconds } = totals;
    process.stdout.write(`\n${files.length} files, ${kb(before)} → ${kb(after)} (${before ? ((1 - after / before) * 100).toFixed(1) : 0}% smaller) in ${seconds.toFixed(1)} s${errors ? `, ${errors} failed` : ""}\n`);
    if (!a.out && !a["in-place"]) process.stdout.write("Dry run: nothing written. Use --out <dir> or --in-place.\n");
  }
  return totals.errors ? 2 : 0;
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
