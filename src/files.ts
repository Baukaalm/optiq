/**
 * Optimise image files and folders on disk: collect, optimise in worker threads, write. Shared by the CLI and the
 * MCP server (`optiq-mcp`); exported from `optiq-image/node`.
 */
import { copyFile, mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { optimizeFiles } from "./batch.js";
import { fileNameFor } from "./client.js";
import { resolveOptions } from "./options.js";
import type { DetectedFormat, OptiqOptions } from "./types.js";

export const IMAGE_EXTENSIONS: readonly string[] = [".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"];

export interface DiskOptions {
  /** Write results to this folder, mirroring each input folder's structure. */
  out?: string;
  /** Overwrite the inputs (write to a temp file, then rename). Use with `allowFormatConversion: false`. */
  inPlace?: boolean;
  /** Worker threads. Default: available cores − 1. */
  concurrency?: number;
  signal?: AbortSignal;
  onResult?: (file: DiskFileResult, done: number, total: number) => void;
}

export interface DiskFileResult {
  /** Absolute input path. */
  file: string;
  from?: string;
  to?: DetectedFormat;
  before?: number;
  after?: number;
  /** 1 − after / before. */
  saved?: number;
  /** SSIM of the result, or "exact" when pixels are verified identical (or the file is unchanged). */
  quality?: number | "exact";
  /** The original was kept (already optimal, already optimised by Optiq, or the saving was below the threshold). */
  usedOriginal?: boolean;
  warnings?: string[];
  /** Absolute path written, if any. */
  written?: string;
  /** `CODE: message` when this file failed; other files are unaffected. */
  error?: string;
}

export interface DiskResult {
  files: DiskFileResult[];
  totals: { files: number; before: number; after: number; saved: number; errors: number; seconds: number };
}

/** Expand files and folders (recursively, skipping dot-entries) into image files, each with the root it came from. */
export async function collectImages(paths: string[]): Promise<{ file: string; root: string }[]> {
  const out: { file: string; root: string }[] = [];
  async function walk(p: string, root: string) {
    const s = await stat(p);
    if (s.isDirectory()) {
      for (const e of (await readdir(p)).sort()) if (!e.startsWith(".")) await walk(join(p, e), root);
    } else if (IMAGE_EXTENSIONS.includes(extname(p).toLowerCase())) out.push({ file: p, root });
  }
  for (const p of paths) {
    const abs = resolve(p);
    const s = await stat(abs);
    await walk(abs, s.isDirectory() ? abs : dirname(abs));
  }
  return out;
}

/**
 * Optimise files on disk. Without `out` or `inPlace` nothing is written (dry run). Per-file failures are reported in
 * the result, not thrown; invalid options and missing paths throw before any work starts.
 */
export async function optimizeFilesOnDisk(paths: string[], options: OptiqOptions, disk: DiskOptions = {}): Promise<DiskResult> {
  if (disk.out && disk.inPlace) throw new Error("Use either out or inPlace, not both");
  resolveOptions(options); // fail fast on bad values instead of once per file
  const t0 = performance.now();
  const files = await collectImages(paths);
  const total = files.length;
  const rows: DiskFileResult[] = new Array(total);
  let done = 0;
  const writes: Promise<void>[] = [];
  await optimizeFiles(
    files.map((f) => f.file),
    options,
    {
      concurrency: disk.concurrency,
      signal: disk.signal,
      onResult: (r, _done, _total, i) => {
        writes.push(
          finishOne(files[i], r, disk).then((row) => {
            rows[i] = row;
            disk.onResult?.(row, ++done, total);
          }),
        );
      },
    },
  );
  await Promise.all(writes);
  let before = 0, after = 0, errors = 0;
  for (const r of rows) {
    if (r.error) errors++;
    else {
      before += r.before!;
      after += r.after!;
    }
  }
  return { files: rows, totals: { files: total, before, after, saved: before ? 1 - after / before : 0, errors, seconds: (performance.now() - t0) / 1000 } };
}

async function finishOne({ file, root }: { file: string; root: string }, r: Awaited<ReturnType<typeof optimizeFiles>>[number], disk: DiskOptions): Promise<DiskFileResult> {
  if (r.error || !r.report) return { file, error: `${r.error?.code ?? "ERROR"}: ${r.error?.message}` };
  const rep = r.report;
  const rel = relative(root, file);
  let written: string | undefined;
  if (r.bytes && disk.inPlace) {
    // Write next to the file, then rename: never leaves a half-written image behind.
    const tmp = `${file}.optiq-tmp`;
    await writeFile(tmp, r.bytes);
    await rename(tmp, file);
    written = file;
  } else if (r.bytes && disk.out) {
    written = join(resolve(disk.out), dirname(rel), fileNameFor(rel.split(/[\\/]/).pop(), rep.outputFormat));
    await mkdir(dirname(written), { recursive: true });
    await writeFile(written, r.bytes);
  } else if (disk.out) {
    // Kept the original: copy it so the output folder is complete.
    written = join(resolve(disk.out), rel);
    await mkdir(dirname(written), { recursive: true });
    await copyFile(file, written);
  }
  return {
    file,
    from: rep.originalFormat,
    to: rep.outputFormat,
    before: rep.originalBytes,
    after: rep.outputBytes,
    saved: rep.sizeReductionRatio,
    quality: rep.qualityMetricName === "exact" ? "exact" : rep.qualityMetric,
    usedOriginal: rep.usedOriginal,
    warnings: rep.warnings,
    written,
  };
}
