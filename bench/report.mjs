// Turns bench/results/{node,browser}.json into bench/results/RESULTS.md.
// Every number in the report comes from those files; nothing is estimated.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(fileURLToPath(new URL(".", import.meta.url)), "results");
const load = async (f) => {
  try {
    return JSON.parse(await readFile(join(dir, f), "utf8"));
  } catch {
    return undefined;
  }
};
const node = await load("node.json");
const nodeV0 = await load("node-v0-before-proxy.json");
const browser = await load("browser.json");

const CATEGORIES = ["photo", "photo-large", "screenshot", "text-graphic", "transparent-illustration", "gradient"];
const LOSSLESS = new Set(["sc-lossless", "sharp-png-max", "sharp-webp-lossless"]);
const median = (xs) => {
  const v = xs.filter((x) => x !== null && x !== undefined && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return undefined;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const pct = (x) => (x === undefined ? "–" : `${(x * 100).toFixed(1)}%`);
const f4 = (x) => (x === undefined ? "–" : x.toFixed(4));
const ms = (x) => (x === undefined ? "–" : x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
const mb = (x) => (x === undefined ? "–" : `${Math.round(x)} MB`);

function table(rows, { lossless, memory }) {
  const tools = [...new Set(rows.map((r) => r.tool))];
  const head = lossless
    ? ["Tool", "n", "Total bytes (in → out)", "Total reduction", "Median reduction", "Pixel-exact", "Median time", ...(memory ? ["Median peak RSS"] : [])]
    : ["Tool", "n", "Total bytes (in → out)", "Total reduction", "Median reduction", "Median SSIM", "Min SSIM", "SSIM ≥ 0.975", "SSIM ≥ 0.99", "Median time", ...(memory ? ["Median peak RSS"] : [])];
  const lines = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const t of tools) {
    const r = rows.filter((x) => x.tool === t && !x.error);
    if (!r.length) continue;
    const inB = sum(r.map((x) => x.originalBytes));
    const outB = sum(r.map((x) => x.bytes));
    const s = r.map((x) => x.ssim).filter((x) => x !== null);
    const cells = [
      `\`${t}\``,
      r.length,
      `${(inB / 1e6).toFixed(2)} MB → ${(outB / 1e6).toFixed(2)} MB`,
      pct(1 - outB / inB),
      pct(median(r.map((x) => x.reduction))),
    ];
    if (lossless) cells.push(`${r.filter((x) => x.exact).length}/${r.length}`);
    else cells.push(f4(median(s)), f4(s.length ? Math.min(...s) : undefined), `${s.filter((x) => x >= 0.975 - 1e-9).length}/${r.length}`, `${s.filter((x) => x >= 0.99 - 1e-9).length}/${r.length}`);
    cells.push(ms(median(r.map((x) => x.timeMs))));
    if (memory) cells.push(mb(median(r.map((x) => x.peakRssMB))));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

/** Per image: does `a` produce fewer bytes with SSIM at least as high as `b` (dominates), or the reverse? */
function headToHead(rows, a, b) {
  const by = (t) => new Map(rows.filter((r) => r.tool === t && !r.error).map((r) => [r.image, r]));
  const A = by(a);
  const B = by(b);
  let aDom = 0, bDom = 0, tradeoff = 0, n = 0;
  for (const [img, ra] of A) {
    const rb = B.get(img);
    if (!rb || ra.ssim === null || rb.ssim === null) continue;
    n++;
    if (ra.bytes <= rb.bytes && ra.ssim >= rb.ssim) aDom++;
    else if (rb.bytes <= ra.bytes && rb.ssim >= ra.ssim) bDom++;
    else tradeoff++;
  }
  return { n, aDom, bDom, tradeoff };
}

function section(title, data, { memory }) {
  if (!data) return `## ${title}\n\n_Not run._\n`;
  const out = [`## ${title}`, "", "Environment: `" + JSON.stringify(data.env) + "`", ""];
  const errors = data.results.filter((r) => r.error);
  const perceptual = data.results.filter((r) => !LOSSLESS.has(r.tool));
  const lossless = data.results.filter((r) => LOSSLESS.has(r.tool));
  out.push("### Perceptual (lossy) results by category", "");
  out.push("SSIM is Optiq's metric (8x8 windows, Y/Cb/Cr 6:1:1, active-window pooling), computed identically for every tool against the decoded input. Fixed-quality baselines do not target a quality, so compare size *and* SSIM.", "");
  for (const c of CATEGORIES) {
    const rows = perceptual.filter((r) => r.category === c);
    if (!rows.length) continue;
    out.push(`#### ${c} (${new Set(rows.map((r) => r.image)).size} images)`, "", table(rows, { lossless: false, memory }), "");
  }
  out.push("#### All categories", "", table(perceptual, { lossless: false, memory }), "");
  if (lossless.length) {
    out.push("### Lossless results by category", "", "Pixel-exact = output decodes to exactly the reference pixels (RGBA) with the same WASM decoders. JPEG inputs are decoded with MozJPEG; libvips' libjpeg-turbo decode differs slightly, so libvips lossless re-encodes of JPEG inputs are not pixel-exact against that reference.", "");
    for (const c of CATEGORIES) {
      const rows = lossless.filter((r) => r.category === c);
      if (rows.length) out.push(`#### ${c}`, "", table(rows, { lossless: true, memory }), "");
    }
    out.push("#### All categories", "", table(lossless, { lossless: true, memory }), "");
  }
  const tools = [...new Set(perceptual.map((r) => r.tool))];
  const ours = tools.filter((t) => t.startsWith("sc-"));
  const theirs = tools.filter((t) => !t.startsWith("sc-"));
  if (ours.length && theirs.length) {
    out.push("### Head-to-head per image", "", "`A dominates` = A is no larger *and* has SSIM ≥ B on that image. `trade-off` = one is smaller, the other has higher SSIM.", "");
    out.push("| A | B | images | A dominates | B dominates | trade-off |", "|---|---|---|---|---|---|");
    for (const a of ours) for (const b of theirs) {
      const h = headToHead(perceptual, a, b);
      if (h.n) out.push(`| \`${a}\` | \`${b}\` | ${h.n} | ${h.aDom} | ${h.bDom} | ${h.tradeoff} |`);
    }
    out.push("");
  }
  if (errors.length) out.push("### Errors", "", ...errors.map((e) => `- ${e.image} / ${e.tool}: ${e.error}`), "");
  out.push("<details><summary>Per-image rows</summary>", "", "| Image | Tool | Bytes | Reduction | SSIM | Format | Time |", "|---|---|---|---|---|---|---|");
  for (const r of data.results.filter((x) => !x.error)) out.push(`| ${r.image} | ${r.tool} | ${r.bytes} | ${pct(r.reduction)} | ${r.ssim === null ? "n/a" : f4(r.ssim)}${r.exact ? " (exact)" : ""} | ${r.outFormat} | ${ms(r.timeMs)} |`);
  out.push("", "</details>", "");
  return out.join("\n");
}

function beforeAfter() {
  if (!node || !nodeV0) return "";
  const key = (r) => `${r.image}|${r.tool}`;
  const v0 = new Map(nodeV0.results.map((r) => [key(r), r]));
  const rows = node.results.filter((r) => r.tool.startsWith("sc-") && r.tool !== "sc-lossless" && v0.has(key(r)));
  const out = [
    "## Optimisation log: tile-mosaic proxy search (Node)",
    "",
    "v0 searched quality with full-resolution encodes. v1 searches on a 3x3 mosaic of 512 px full-resolution tiles for images above 4 MP and verifies only the finalists at full size; `balanced` rows additionally use AVIF speed 7 instead of 8 (see docs/architecture.md). Same corpus, same machine; v0 data: `bench/results/node-v0-before-proxy.json`.",
    "",
    "| Image | Tool | Bytes v0 → v1 | SSIM v0 → v1 | Time v0 → v1 | Peak RSS v0 → v1 |",
    "|---|---|---|---|---|---|",
  ];
  let t0 = 0, t1 = 0, b0 = 0, b1 = 0;
  for (const r of rows) {
    const o = v0.get(key(r));
    if (o.timeMs < 2000 && r.timeMs < 2000) continue; // only list runs where the change matters
    t0 += o.timeMs; t1 += r.timeMs; b0 += o.bytes; b1 += r.bytes;
    out.push(`| ${r.image} | ${r.tool} | ${o.bytes} → ${r.bytes} (${(((r.bytes - o.bytes) / o.bytes) * 100).toFixed(1)}%) | ${f4(o.ssim)} → ${f4(r.ssim)} | ${ms(o.timeMs)} → ${ms(r.timeMs)} | ${mb(o.peakRssMB)} → ${mb(r.peakRssMB)} |`);
  }
  if (t0) out.push("", `Listed runs: total time ${ms(t0)} → ${ms(t1)}, total output ${(b0 / 1e6).toFixed(2)} MB → ${(b1 / 1e6).toFixed(2)} MB.`, "");
  return out.join("\n");
}

const md = [
  "# Benchmark results",
  "",
  "Generated by `node bench/report.mjs` from `bench/results/node.json` and `bench/results/browser.json`. Do not edit by hand.",
  "Corpus: `bench/corpus/manifest.json` (sources, sizes and SHA-256 of every image).",
  "",
  section("Node.js: Optiq engine vs libvips (sharp)", node, { memory: true }),
  section("Browser (Chromium): Optiq vs browser-image-compression and canvas", browser, { memory: false }),
  beforeAfter(),
].join("\n");
await writeFile(join(dir, "RESULTS.md"), md);
console.log("wrote bench/results/RESULTS.md");
