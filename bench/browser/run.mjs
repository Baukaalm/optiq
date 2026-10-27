// Browser benchmark (Playwright Chromium): Optiq (Web Worker + WASM) vs browser-image-compression and
// native canvas encoders. Outputs are scored in Node with the same decoder + SSIM as every other benchmark.
// Usage: node bench/browser/run.mjs [--only substring] [--tools a,b]
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium } from "playwright";
import { decodeOriented, score } from "../common.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const benchDir = join(here, "..");
const appDir = fileURLToPath(new URL("../../test-results/bench-app", import.meta.url));
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const TOOLS = args.includes("--tools")
  ? args[args.indexOf("--tools") + 1].split(",")
  : ["sc-balanced", "sc-visually-lossless", "sc-lossless", "bic-maxsize-1mb", "bic-quality-0.8", "bic-webp-0.8", "canvas-webp-0.8", "canvas-jpeg-0.8"];

await build({ configFile: join(here, "vite.config.ts") });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg" };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = path.startsWith("/corpus/") ? join(benchDir, "corpus/images", path.slice(8)) : join(appDir, path === "/" ? "index.html" : path);
  try {
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const manifest = JSON.parse(await readFile(join(benchDir, "corpus/manifest.json"), "utf8"));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(base + "/");
await page.waitForFunction(() => typeof window.benchOne === "function");
// Warm-up: worker start and WASM compilation are excluded from per-image timings.
await page.evaluate((u) => window.benchOne(u, "w.png", "sc-balanced"), `${base}/corpus/transparent-icon.png`);
const userAgent = await page.evaluate(() => navigator.userAgent);

const outDir = join(benchDir, "results/raw/browser");
await mkdir(outDir, { recursive: true });
const results = [];
for (const img of manifest.images) {
  if (only && !img.file.includes(only)) continue;
  const reference = (await decodeOriented(new Uint8Array(await readFile(join(benchDir, "corpus/images", img.file))))).img;
  for (const tool of TOOLS) {
    if (tool === "canvas-jpeg-0.8" && img.category === "transparent-illustration") continue;
    const r = await page.evaluate(([u, n, t]) => window.benchOne(u, n, t), [`${base}/corpus/${img.file}`, img.file, tool]);
    if (r.error) {
      results.push({ image: img.file, category: img.category, tool, error: r.error });
      console.log(`${img.file.padEnd(32)} ${tool.padEnd(22)} ERROR ${r.error}`);
      continue;
    }
    const bytes = new Uint8Array(Buffer.from(r.base64, "base64"));
    await writeFile(join(outDir, `${img.file}.${tool}.out`), bytes);
    const q = await score(reference, bytes);
    const row = { image: img.file, category: img.category, tool, originalBytes: img.bytes, bytes: r.bytes, timeMs: r.timeMs, outFormat: q.format, exact: q.exact, ssim: q.ssim, reduction: 1 - r.bytes / img.bytes, note: q.note };
    results.push(row);
    console.log(`${img.file.padEnd(32)} ${tool.padEnd(22)} ${String(r.bytes).padStart(9)} B  ${(row.reduction * 100).toFixed(1).padStart(6)}%  ssim=${q.ssim === null ? "n/a" : q.ssim.toFixed(4)} ${q.format.padEnd(5)} ${Math.round(r.timeMs)} ms`);
  }
}
await browser.close();
server.close();
const env = { runtime: `Chromium ${browser.version()} (Playwright, headless)`, userAgent, platform: `${process.platform}-${process.arch}`, date: new Date().toISOString(), memory: "not measured in the browser (see Node benchmark for peak RSS)" };
let all = results;
if (args.includes("--merge")) {
  // Replace only the re-measured (image, tool) rows in the existing results file.
  const prev = JSON.parse(await readFile(join(benchDir, "results/browser.json"), "utf8"));
  const k = (r) => `${r.image}|${r.tool}`;
  const fresh = new Map(results.map((r) => [k(r), r]));
  all = prev.results.map((r) => fresh.get(k(r)) ?? r);
  for (const r of results) if (!prev.results.some((p) => k(p) === k(r))) all.push(r);
  env.merged = [...(prev.env.merged ?? []), `${env.date}: ${[...new Set(results.map((r) => r.tool))].join(",")}`];
}
await writeFile(join(benchDir, "results/browser.json"), JSON.stringify({ env, results: all }, null, 2) + "\n");
console.log("\nwrote bench/results/browser.json");
