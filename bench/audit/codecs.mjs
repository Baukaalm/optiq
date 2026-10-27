// Where does time go? Same codec, same settings: WASM (jSquash, as used by SmartCompress) vs native libvips (sharp,
// single-threaded), plus SmartCompress's own JS work per candidate (SSIM, exact compare, copies, classification).
// Median of N runs after one warm-up. Usage: node bench/audit/codecs.mjs   (needs the corpus and `pnpm build`)
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createWasmBackend, initNodeCodecs } from "../../dist/node.js";
import { ssim } from "../../dist/quality.js";
import { pixelsEqual, tileMosaic } from "../../dist/pixels.js";
import { classify } from "../../dist/classify.js";

sharp.concurrency(1);
sharp.cache(false);
const here = fileURLToPath(new URL(".", import.meta.url));
const N = Number(process.env.RUNS ?? 5);

async function time(fn, n = N) {
  await fn();
  const t = [];
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    await fn();
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  return t[t.length >> 1];
}

const tInit = performance.now();
await initNodeCodecs();
const initMs = performance.now() - tInit;
const w = createWasmBackend();
const images = { "kodim23 (0.4 MP)": "photo-kodim23.jpg", "screenshot (1 MP)": "screenshot-code.png", "phone (12 MP)": "large-picsum1015.jpg" };
const rows = [];
const add = (image, op, wasmMs, nativeMs, note = "") => {
  rows.push({ image, op, wasmMs, nativeMs, ratio: nativeMs ? wasmMs / nativeMs : undefined, note });
  console.log(`${image.padEnd(18)} ${op.padEnd(34)} wasm/js ${wasmMs.toFixed(1).padStart(8)} ms   native ${nativeMs ? nativeMs.toFixed(1).padStart(8) + " ms" : "       –   "}  ${nativeMs ? (wasmMs / nativeMs).toFixed(2) + "x" : ""} ${note}`);
};

for (const [label, file] of Object.entries(images)) {
  const bytes = new Uint8Array(await readFile(join(here, "../corpus/images", file)));
  const fmt = file.endsWith(".png") ? "png" : "jpeg";
  const img = await w.decode(fmt, bytes);
  const rawSharp = () => sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), { raw: { width: img.width, height: img.height, channels: 4 }, limitInputPixels: false });
  const big = img.width * img.height > 4e6;
  const reps = big ? 3 : N;

  add(label, `decode ${fmt}`, await time(() => w.decode(fmt, bytes), reps), await time(() => sharp(bytes, { limitInputPixels: false }).raw().toBuffer(), reps));
  add(label, "encode jpeg q80 (mozjpeg)", await time(() => w.encode("jpeg", img, { quality: 80 }), reps), await time(() => rawSharp().jpeg({ quality: 80, mozjpeg: true }).toBuffer(), reps));
  add(label, "encode webp q80 m4", await time(() => w.encode("webp", img, { quality: 80, method: 4 }), reps), await time(() => rawSharp().webp({ quality: 80, effort: 4 }).toBuffer(), reps));
  if (!big) {
    add(label, "encode avif q50 speed6", await time(() => w.encode("avif", img, { quality: 50, speed: 6 }), 3), await time(() => rawSharp().avif({ quality: 50, effort: 3 }).toBuffer(), 3), "native effort 3 ≈ libaom speed 6");
    for (const [m, q] of [[4, 75], [5, 75], [6, 100]]) {
      const enc = await w.encode("webp", img, { lossless: true, method: m, quality: q, exact: true });
      add(label, `encode webp lossless m${m} q${q}`, await time(() => w.encode("webp", img, { lossless: true, method: m, quality: q, exact: true }), 3), 0, `${enc.length} B`);
    }
    for (const level of [2, 3]) {
      const enc = await w.encode("png", img, { level });
      add(label, `encode png oxipng level ${level}`, await time(() => w.encode("png", img, { level }), 3), 0, `${enc.length} B`);
    }
  }
  const other = await w.decode("jpeg", await w.encode("jpeg", img, { quality: 80 }));
  add(label, "ssim (JS)", await time(() => ssim(img, other), reps), 0);
  add(label, "exact compare (JS)", await time(() => pixelsEqual(img, other), reps), 0);
  add(label, "classify (JS)", await time(() => classify(img), reps), 0);
  add(label, "RGBA copy (slice)", await time(() => img.data.slice(), reps), 0, "cost of one extra buffer copy");
  if (big) add(label, "tile mosaic (JS)", await time(() => tileMosaic(img), reps), 0);
}
console.log(`\nWASM module compile+init (all codecs, Node): ${initMs.toFixed(0)} ms`);
await writeFile(join(here, "../results/codecs.json"), JSON.stringify({ date: new Date().toISOString(), node: process.version, initMs, rows }, null, 2) + "\n");
