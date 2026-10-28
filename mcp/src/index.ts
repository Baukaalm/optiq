#!/usr/bin/env node
/**
 * optiq-mcp: an MCP server (stdio) that exposes Optiq's image optimisation to AI agents.
 * Two tools: `analyze_images` (read-only dry run) and `optimize_images` (writes in place or to a folder).
 * Everything runs locally with the same WASM codecs and quality checks as the `optiq-image` library and CLI.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { optimizeFilesOnDisk, type DiskFileResult, type DiskOptions, type DiskResult } from "optiq-image/node";
import type { OptiqOptions, OutputFormat } from "optiq-image";
import * as z from "zod/v4";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** Keep tool results readable for the model: list at most this many files (totals always cover all of them). */
const MAX_LISTED = 200;

const INSTRUCTIONS = `Optiq optimises raster images (JPEG, PNG, WebP, AVIF, GIF) on the local disk and verifies the result:
pixel-exact in "lossless" mode, SSIM against the input in the perceptual modes. It never uploads anything.
Recommended flow: call analyze_images first (read-only) and show the user the expected savings, then call
optimize_images. Prefer write: "in-place" for images referenced from code (formats are kept, so references stay
valid). Files that Optiq already compressed lossily carry a small marker and are skipped, so re-running is safe.
SVG and HEIC are not handled. Use absolute paths.`;

const common = {
  paths: z.array(z.string()).min(1).describe("Image files and/or folders (searched recursively, dot-folders skipped). Absolute paths recommended."),
  mode: z
    .enum(["lossless", "visually-lossless", "balanced", "fast"])
    .default("balanced")
    .describe(
      "lossless: pixels verified identical. visually-lossless: SSIM >= 0.99. balanced (default): SSIM >= 0.975. fast: like balanced, no AVIF, fewer encodes. Use visually-lossless for hero images, artwork, product photos.",
    ),
  keepFormat: z
    .boolean()
    .optional()
    .describe("Never change the file format. Default: true for in-place writes and analysis, false when writing to outDir."),
  formats: z
    .array(z.enum(["jpeg", "png", "webp", "avif"]))
    .optional()
    .describe("Formats allowed when the format may change. Default all four. Drop avif if the site must support old browsers."),
  maxSize: z.number().int().positive().optional().describe("Downscale so the longest side is at most this many pixels."),
  stripMetadata: z.boolean().default(false).describe("Remove EXIF (including GPS location) and XMP. Recommended before publishing photos."),
  minQuality: z.number().gt(0).max(1).optional().describe("Custom SSIM threshold for perceptual modes, e.g. 0.98."),
  minSaving: z.number().min(0).lt(1).optional().describe("Keep a file unchanged unless it gets at least this much smaller. Default 0.02."),
};

const fileResult = z.object({
  file: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  before: z.number().optional(),
  after: z.number().optional(),
  saved: z.number().optional(),
  quality: z.union([z.number(), z.literal("exact")]).optional(),
  usedOriginal: z.boolean().optional(),
  warnings: z.array(z.string()).optional(),
  written: z.string().optional(),
  error: z.string().optional(),
});
const resultSchema = z.object({
  dryRun: z.boolean(),
  totals: z.object({ files: z.number(), before: z.number(), after: z.number(), saved: z.number(), errors: z.number(), seconds: z.number() }),
  files: z.array(fileResult),
  omittedFiles: z.number().describe("Files processed but not listed (the list is capped); totals include them."),
});

const commonSchema = z.object(common);
type Common = z.infer<typeof commonSchema> & { reoptimize?: boolean };

function engineOptions(a: Common, keepFormat: boolean): OptiqOptions {
  return {
    mode: a.mode,
    allowFormatConversion: !keepFormat,
    autoFormats: a.formats as OutputFormat[] | undefined,
    maxWidthOrHeight: a.maxSize,
    allowLossyResize: a.maxSize !== undefined,
    preserveMetadata: !a.stripMetadata,
    minQuality: a.minQuality,
    minSavingsRatio: a.minSaving,
    markOutput: true,
    reoptimize: a.reoptimize ?? false,
  };
}

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);

function summary(r: DiskResult, dryRun: boolean): string {
  const { files, before, after, errors, seconds } = r.totals;
  const head = `${dryRun ? "Dry run (nothing written)" : "Done"}: ${files} images, ${kb(before)} -> ${kb(after)} (${(r.totals.saved * 100).toFixed(1)}% smaller) in ${seconds.toFixed(1)} s${errors ? `, ${errors} failed` : ""}.`;
  const lines = r.files.slice(0, MAX_LISTED).map((f: DiskFileResult) =>
    f.error
      ? `x ${f.file}: ${f.error}`
      : `${f.usedOriginal ? "=" : dryRun ? "~" : "v"} ${f.file}: ${f.from} -> ${f.to}, ${kb(f.before!)} -> ${kb(f.after!)} (${(f.saved! * 100).toFixed(1)}%), ${f.quality === "exact" ? "pixel-exact" : `SSIM ${f.quality!.toFixed(4)}`}${f.warnings?.length ? ` [${f.warnings.join("; ")}]` : ""}`,
  );
  if (r.files.length > MAX_LISTED) lines.push(`... ${r.files.length - MAX_LISTED} more files (see totals)`);
  return [head, ...lines].join("\n");
}

async function run(a: Common, keepFormat: boolean, disk: DiskOptions, ctx: ServerContext) {
  const paths = a.paths.map((p) => resolve(p));
  const token = ctx.mcpReq._meta?.progressToken;
  const result = await optimizeFilesOnDisk(paths, engineOptions(a, keepFormat), {
    ...disk,
    signal: ctx.mcpReq.signal,
    onResult:
      token === undefined
        ? undefined
        : (f, done, total) =>
            void ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: done, total, message: f.file } }).catch(() => {}),
  });
  const dryRun = !disk.out && !disk.inPlace;
  const structured = { dryRun, totals: result.totals, files: result.files.slice(0, MAX_LISTED), omittedFiles: Math.max(0, result.files.length - MAX_LISTED) };
  if (!result.files.length) {
    return { content: [{ type: "text" as const, text: "No images found (jpg, jpeg, png, webp, avif, gif) under the given paths." }], structuredContent: structured, isError: true };
  }
  return { content: [{ type: "text" as const, text: summary(result, dryRun) }], structuredContent: structured };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "optiq", version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "analyze_images",
    {
      title: "Analyze images (dry run)",
      description:
        "Read-only. Runs the full optimisation in memory and reports, per image, the format Optiq would choose, size before/after, and the measured quality (SSIM or pixel-exact). Writes nothing. Use it to estimate savings before optimize_images.",
      inputSchema: commonSchema,
      outputSchema: resultSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a, ctx) => run(a, a.keepFormat ?? true, {}, ctx),
  );

  server.registerTool(
    "optimize_images",
    {
      title: "Optimize images",
      description:
        'Optimises images and writes the results. write: "in-place" overwrites each file and keeps its format (safe for files referenced from code; atomic rename). write: "out-dir" writes to outDir mirroring the folder structure and may change formats (file extensions change accordingly; update references). A file is only replaced when the result passes the quality check and is smaller. Files Optiq already compressed lossily are skipped (unless reoptimize is true), so calling this twice is safe.',
      inputSchema: z.object({
        ...common,
        write: z.enum(["in-place", "out-dir"]).describe('"in-place" overwrites inputs; "out-dir" writes to outDir.'),
        outDir: z.string().optional().describe('Required when write is "out-dir".'),
        reoptimize: z.boolean().default(false).describe("Re-encode files Optiq already compressed lossily. Each lossy pass loses a little more quality; leave false unless the user asks."),
      }),
      outputSchema: resultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (a, ctx) => {
      if (a.write === "out-dir" && !a.outDir) {
        return { content: [{ type: "text" as const, text: 'outDir is required when write is "out-dir".' }], isError: true };
      }
      const inPlace = a.write === "in-place";
      return run(a, inPlace || (a.keepFormat ?? false), inPlace ? { inPlace: true } : { out: resolve(a.outDir!) }, ctx);
    },
  );
  return server;
}

serveStdio(createServer);
