// Node benchmark: SmartCompress engine (same WASM codecs as in the browser) vs native libvips (sharp) encoders.
// Usage: node bench/node/run.mjs [--only substring] [--tools a,b]
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { decodeOriented, score } from "../common.mjs";

const run = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const benchDir = join(here, "..");
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const TOOLS = args.includes("--tools")
  ? args[args.indexOf("--tools") + 1].split(",")
  : ["sc-balanced", "sc-balanced-nometa", "sc-visually-lossless", "sc-lossless", "sharp-mozjpeg-q80", "sharp-webp-q80", "sharp-avif-q50", "sharp-png-max", "sharp-webp-lossless"];

const manifest = JSON.parse(await readFile(join(benchDir, "corpus/manifest.json"), "utf8"));
const outDir = join(benchDir, "results/raw/node");
await mkdir(outDir, { recursive: true });
const sharpVersion = JSON.parse(await readFile(join(benchDir, "../node_modules/sharp/package.json"), "utf8")).version;
const results = [];
for (const img of manifest.images) {
  if (only && !img.file.includes(only)) continue;
  const input = join(benchDir, "corpus/images", img.file);
  const reference = (await decodeOriented(new Uint8Array(await readFile(input)))).img;
  for (const tool of TOOLS) {
    const outPath = join(outDir, `${img.file}.${tool}.out`);
    const { stdout } = await run(process.execPath, ["--expose-gc", join(here, "child.mjs"), tool, input, outPath], { maxBuffer: 1 << 24 });
    const m = JSON.parse(stdout.trim().split("\n").at(-1));
    if (m.skipped) continue;
    const q = await score(reference, new Uint8Array(await readFile(outPath)));
    const row = { image: img.file, category: img.category, tool, originalBytes: img.bytes, ...m, outFormat: q.format, exact: q.exact, ssim: q.ssim, reduction: 1 - m.bytes / img.bytes };
    results.push(row);
    console.log(`${img.file.padEnd(32)} ${tool.padEnd(22)} ${String(m.bytes).padStart(9)} B  ${(row.reduction * 100).toFixed(1).padStart(6)}%  ssim=${q.ssim === null ? "n/a" : q.ssim.toFixed(4)} ${q.format.padEnd(5)} ${Math.round(m.timeMs)} ms  peak ${Math.round(m.peakRssMB)} MB`);
  }
}
const env = { runtime: `node ${process.version}`, platform: `${process.platform}-${process.arch}`, cpu: cpus()[0]?.model, cores: cpus().length, memGB: Math.round(totalmem() / 2 ** 30), sharp: sharpVersion, date: new Date().toISOString() };
let all = results;
if (args.includes("--merge")) {
  // Replace only the re-measured (image, tool) rows in the existing results file.
  const prev = JSON.parse(await readFile(join(benchDir, "results/node.json"), "utf8"));
  const k = (r) => `${r.image}|${r.tool}`;
  const fresh = new Map(results.map((r) => [k(r), r]));
  all = prev.results.map((r) => fresh.get(k(r)) ?? r);
  for (const r of results) if (!prev.results.some((p) => k(p) === k(r))) all.push(r);
  env.merged = [...(prev.env.merged ?? []), `${env.date}: ${[...new Set(results.map((r) => r.tool))].join(",")}`];
}
await writeFile(join(benchDir, "results/node.json"), JSON.stringify({ env, results: all }, null, 2) + "\n");
console.log("\nwrote bench/results/node.json");
