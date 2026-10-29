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
SVG is optimised with SVGO and verified by rendering (ids kept; not a sanitiser). HEIC is not handled.
Use absolute paths.`;

const common = {
  paths: z
    .array(z.string())
    .min(1)
    .describe("Image files and/or folders. Folders are searched recursively for jpg, jpeg, png, webp, avif, gif and svg; dot-folders are skipped. Use absolute paths; relative ones resolve against the server's working directory."),
  mode: z
    .enum(["lossless", "visually-lossless", "balanced", "fast"])
    .default("balanced")
    .describe(
      "How strict the quality check is. lossless: decoded pixels verified identical (JPEG inputs only get metadata changes). visually-lossless: SSIM >= 0.99. balanced (default): SSIM >= 0.975. fast: same threshold as balanced, no AVIF, at most 5 encodes, about 3x faster. Use visually-lossless for hero images, artwork and product photos.",
    ),
  keepFormat: z
    .boolean()
    .optional()
    .describe("Never change the file format (a .png stays PNG). Default: true for in-place writes and for analysis, false when writing to outDir. Set false in analysis to see what converting to WebP/AVIF would save."),
  formats: z
    .array(z.enum(["jpeg", "png", "webp", "avif"]))
    .optional()
    .describe("Formats Optiq may choose when the format may change. Default: all four (fast mode: no avif). Drop avif if the site must support browsers older than Safari 16.4. JPEG is never chosen for images with transparency."),
  maxSize: z.number().int().positive().optional().describe("Downscale so the longest side is at most this many pixels, e.g. 2560 for camera photos on a website. Smaller images are not enlarged. Allowed in lossless mode too (the resize itself changes pixels)."),
  stripMetadata: z.boolean().default(false).describe("Remove EXIF (including GPS location, camera serial) and XMP. Recommended before publishing personal photos. Colour profiles that matter (non-sRGB ICC) and image orientation are preserved either way."),
  minQuality: z.number().gt(0).max(1).optional().describe("Custom SSIM threshold for perceptual modes instead of the mode's default, e.g. 0.98. Higher keeps more detail and saves less. Ignored in lossless mode."),
  minSaving: z.number().min(0).lt(1).optional().describe("Keep a file unchanged unless it gets at least this share smaller (0.05 = 5%). Default 0.02. Raise it to avoid churning files for tiny gains."),
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
        "Read-only dry run: runs the full optimisation in memory and reports, per image, the format Optiq would choose, bytes before and after, and the measured quality (SSIM, or pixel-exact). Writes nothing. Use it first to show the user the expected savings, then call optimize_images with the same arguments. " +
        "Main parameters: paths (files or folders), mode (how strict the quality check is), keepFormat/formats (whether and to what the format may change), maxSize (downscale), stripMetadata (drop EXIF/GPS). " +
        "Cost: it does the same work as optimize_images, several encodes per image, typically 0.3-3 s per image on a modern laptop (fast mode is quicker; very large screenshots in visually-lossless can take tens of seconds). For hundreds of images, try one subfolder first. Progress is reported per file and the call can be cancelled.",
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
        'Optimises images and writes the results. If the user only wants to know how much could be saved, or has not agreed to changes yet, use analyze_images instead: it takes the same arguments and writes nothing. ' +
        'write: "in-place" overwrites each file and keeps its format and name, so references in code stay valid (atomic rename). write: "out-dir" writes to outDir, mirroring the folder structure, and may change formats; extensions change accordingly, so update references. ' +
        "A file is only replaced when the result passes the quality check and is smaller. Files Optiq already compressed lossily are skipped (unless reoptimize is true), so calling this twice is safe. " +
        "Choosing parameters: mode visually-lossless for hero images, artwork and product photos, lossless for logos and UI assets that must stay exact, balanced otherwise; stripMetadata before publishing personal photos (GPS); formats without avif if old browsers matter. " +
        "Takes the same time as analyze_images (typically 0.3-3 s per image).",
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
