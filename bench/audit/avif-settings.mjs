// Which AVIF settings give the fewest bytes *at a fixed SSIM target* for graphics? For each image and setting,
// bisect the quality to the smallest value that meets the target (exact, step 1) and record the bytes.
// Usage: node bench/audit/avif-settings.mjs   (needs the corpus and `pnpm build`)
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWasmBackend, initNodeCodecs } from "../../dist/node.js";
import { ssim } from "../../dist/quality.js";

const here = fileURLToPath(new URL(".", import.meta.url));
await initNodeCodecs();
const w = createWasmBackend();
const manifest = JSON.parse(await readFile(join(here, "../corpus/manifest.json"), "utf8"));
const images = manifest.images.filter((i) => ["transparent-illustration", "screenshot", "text-graphic"].includes(i.category) && i.width * i.height <= 2e6);
const SETTINGS = {
  "444 boost25": { chroma: "444", alphaBoost: 25 },
  "444 boost0": { chroma: "444", alphaBoost: 0 },
  "420 boost25": { chroma: "420", alphaBoost: 25 },
  "420 boost0": { chroma: "420", alphaBoost: 0 },
};
async function minBytes(img, settings, target) {
  let lo = 20, hi = 98, best;
  while (lo <= hi) {
    const q = (lo + hi) >> 1;
    const bytes = await w.encode("avif", img, { ...settings, speed: 7, quality: q });
    const s = ssim(img, await w.decode("avif", bytes)).ssim;
    if (s >= target) {
      best = { q, bytes: bytes.length, ssim: s };
      hi = q - 1;
    } else lo = q + 1;
  }
  return best;
}
const results = [];
for (const im of images) {
  const bytes = new Uint8Array(await readFile(join(here, "../corpus/images", im.file)));
  const img = await w.decode("png", bytes);
  for (const target of [0.975, 0.99]) {
    const line = [];
    for (const [name, s] of Object.entries(SETTINGS)) {
      if (name.includes("boost25") && im.category !== "transparent-illustration") continue;
      const r = await minBytes(img, s, target);
      results.push({ image: im.file, category: im.category, target, setting: name, ...r });
      line.push(`${name}: ${r ? `${r.bytes} B (q${r.q})` : "unreachable"}`);
    }
    console.log(`${im.file.padEnd(32)} ssim>=${target}  ${line.join("  |  ")}`);
  }
}
const totals = {};
for (const r of results) if (r.bytes) (totals[`${r.target} ${r.setting}`] ??= []).push(r);
console.log("\nTotal bytes per setting (only images where every setting was tried):");
for (const [k, v] of Object.entries(totals)) console.log(`  ${k.padEnd(20)} ${v.reduce((a, b) => a + b.bytes, 0)} B over ${v.length} images`);
await writeFile(join(here, "../results/avif-settings.json"), JSON.stringify({ date: new Date().toISOString(), results }, null, 2) + "\n");
