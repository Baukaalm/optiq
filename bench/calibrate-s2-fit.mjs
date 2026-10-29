// Fit a per-codec SSIM threshold from bench/results/calibrate-s2.jsonl.
// For a threshold T, each (image, codec) curve gives the smallest grid quality whose SSIM ≥ T; we read SSIMULACRA2 and
// bytes there (linear interpolation between grid points). JPEG/WebP at the engine's thresholds are the reference;
// for AVIF we search k in T_avif = 1 − k·(1 − T) so that AVIF's SSIMULACRA2 matches them, in both perceptual modes.
// Fit on the benchmark corpus, report the held-out split separately. Usage: node bench/calibrate-s2-fit.mjs
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const rows = (await readFile(join(here, "results/calibrate-s2.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)).filter((r) => !r.error);
const curves = new Map();
for (const r of rows) {
  const k = `${r.set}|${r.file}|${r.format}`;
  if (!curves.has(k)) curves.set(k, { set: r.set, file: r.file, format: r.format, category: r.category, transparent: r.transparent, pts: [] });
  curves.get(k).pts.push(r);
}
for (const c of curves.values()) c.pts.sort((a, b) => a.q - b.q);

const threshold = (category, T) => (category === "gradient" ? T + (1 - T) / 2 : T); // engine's gradient rule
/** SSIMULACRA2 and bytes where the curve first reaches SSIM ≥ t; null when even the top grid quality does not. */
function at(c, t) {
  const p = c.pts;
  const i = p.findIndex((x) => x.ssim >= t);
  if (i < 0) return null;
  if (i === 0) return { s2: p[0].s2, bytes: p[0].bytes };
  const a = p[i - 1], b = p[i], f = (t - a.ssim) / (b.ssim - a.ssim);
  return { s2: a.s2 + f * (b.s2 - a.s2), bytes: a.bytes + f * (b.bytes - a.bytes) };
}
const pct = (a, q) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};
const summary = (set, format, T, k = 1) => {
  const vals = [...curves.values()]
    .filter((c) => c.set === set && c.format === format)
    .map((c) => at(c, 1 - k * (1 - threshold(c.category, T))))
    .filter(Boolean);
  const s2 = vals.map((v) => v.s2);
  return { n: vals.length, p10: pct(s2, 0.1), median: pct(s2, 0.5), bytes: vals.reduce((t, v) => t + v.bytes, 0) };
};
const fmt = (s) => `n=${String(s.n).padStart(3)}  p10 ${s.p10.toFixed(1).padStart(5)}  median ${s.median.toFixed(1).padStart(5)}  bytes ${(s.bytes / 1e6).toFixed(2)} MB`;

for (const T of [0.975, 0.99]) {
  console.log(`\n=== engine threshold T = ${T} (${T === 0.975 ? "balanced" : "visually-lossless"})`);
  for (const set of ["bench", "heldout"]) {
    console.log(`-- ${set}`);
    for (const f of ["jpeg", "webp", "avif"]) console.log(`  ${f.padEnd(5)} at T          ${fmt(summary(set, f, T))}`);
  }
}

// Paired comparison on the same images: AVIF at T_avif = 1 − k·(1 − T) vs WebP at T. Images where AVIF cannot reach
// T_avif within the grid are counted as "AVIF unavailable" (the engine would then pick another codec).
function paired(set, T, k) {
  const d = [], ratio = [];
  let n = 0, unavailable = 0;
  for (const c of curves.values()) {
    if (c.set !== set || c.format !== "avif") continue;
    const w = curves.get(`${c.set}|${c.file}|webp`);
    const wv = w && at(w, threshold(c.category, T));
    if (!wv) continue;
    n++;
    const av = at(c, 1 - k * (1 - threshold(c.category, T)));
    if (!av) {
      unavailable++;
      continue;
    }
    d.push(av.s2 - wv.s2);
    ratio.push(av.bytes / wv.bytes);
  }
  return { n, unavailable, dMedian: pct(d, 0.5), dP10: pct(d, 0.1), bytesRatio: pct(ratio, 0.5), smaller: ratio.filter((r) => r < 1).length / Math.max(1, ratio.length) };
}
const pf = (p) =>
  `avail ${String(p.n - p.unavailable).padStart(3)}/${String(p.n).padEnd(3)} s2 diff median ${p.dMedian.toFixed(1).padStart(5)} p10 ${p.dP10.toFixed(1).padStart(6)}  bytes avif/webp median ${p.bytesRatio.toFixed(2)}  avif smaller on ${(p.smaller * 100).toFixed(0)}%`;
console.log("\n=== Paired: AVIF at T_avif = 1 − k·(1 − T) minus WebP at T, same image");
for (const set of ["bench", "heldout"]) {
  for (const T of [0.975, 0.99]) {
    console.log(`-- ${set}, T=${T}`);
    for (const k of [1, 0.8, 0.7, 0.6, 0.5, 0.4]) console.log(`  k=${k.toFixed(2)}  ${pf(paired(set, T, k))}`);
  }
}
