// One (tool, image) measurement in a fresh process, so peak RSS is attributable to that run.
// Prints a JSON line; writes the output bytes to argv[4].
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { initNodeCodecs, optimizeInNode } from "../../dist/node.js";

const [tool, input, outPath] = process.argv.slice(2);
sharp.concurrency(1); // single-threaded like the WASM codecs, for a fair time comparison
sharp.cache(false);
await initNodeCodecs();
const bytes = new Uint8Array(await readFile(input));
global.gc?.();
const baseRss = process.memoryUsage().rss;

const SC = {
  "sc-balanced": { mode: "balanced" },
  "sc-balanced-nometa": { mode: "balanced", preserveMetadata: false },
  "sc-visually-lossless": { mode: "visually-lossless" },
  "sc-lossless": { mode: "lossless" },
};
const t0 = performance.now();
let out;
let meta = {};
if (SC[tool]) {
  const r = await optimizeInNode(bytes, SC[tool]);
  out = r.bytes ?? bytes;
  const { candidates, warnings, ...rest } = r.report;
  meta = { codec: rest.codec, settings: rest.settings, engineCategory: rest.category, usedOriginal: rest.usedOriginal, candidates: candidates.length, constraintsMet: rest.constraintsMet, engineQuality: rest.qualityMetric, warnings };
} else {
  const s = sharp(bytes, { limitInputPixels: false });
  const opaque = !(await s.stats()).isOpaque === false;
  switch (tool) {
    case "sharp-mozjpeg-q80":
      if (!opaque) {
        console.log(JSON.stringify({ skipped: "has alpha" }));
        process.exit(0);
      }
      out = await s.jpeg({ quality: 80, mozjpeg: true }).toBuffer();
      break;
    case "sharp-webp-q80":
      out = await s.webp({ quality: 80 }).toBuffer();
      break;
    case "sharp-avif-q50":
      out = await s.avif({ quality: 50 }).toBuffer();
      break;
    case "sharp-png-max":
      out = await s.png({ compressionLevel: 9, adaptiveFiltering: true, effort: 10 }).toBuffer();
      break;
    case "sharp-webp-lossless":
      out = await s.webp({ lossless: true, effort: 6 }).toBuffer();
      break;
    default:
      throw new Error(`unknown tool ${tool}`);
  }
  meta = { codec: tool.replace(/^sharp-/, "libvips-") };
}
const timeMs = performance.now() - t0;
const peakRssMB = process.resourceUsage().maxRSS / 1024;
await writeFile(outPath, out);
console.log(JSON.stringify({ bytes: out.length, timeMs, peakRssMB, baseRssMB: baseRss / 1048576, ...meta }));
