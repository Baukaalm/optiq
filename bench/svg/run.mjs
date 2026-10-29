// SVG benchmark: Optiq (SVGO, verified by rendering) vs SVGO's default preset without any check, on real files.
// Files: Wikimedia Commons logos and illustrations (downloaded on first run into bench/svg/images, not committed;
// licences on each file's Commons page) plus Optiq's own logos. Needs `pnpm build`.
// Usage: node bench/svg/run.mjs
import { mkdir, readFile, readdir, writeFile, copyFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const dir = join(here, "images");
const COMMONS = [
  "Flag_of_Kazakhstan.svg", "Wikipedia-logo-v2.svg", "Tux.svg", "Ghostscript_Tiger.svg", "Inkscape_Logo.svg", "Git-logo.svg",
  "Python-logo-notext.svg", "Node.js_logo.svg", "SVG_Logo.svg", "Commons-logo.svg", "Firefox_logo,_2019.svg",
  "Openstreetmap_logo.svg", "Wikimedia-logo.svg", "Flag_of_the_United_States.svg", "Bitmap_VS_SVG.svg",
];
await mkdir(dir, { recursive: true });
for (const f of COMMONS) {
  if (await stat(join(dir, f)).catch(() => null)) continue;
  const r = await fetch(`https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(f)}`, { headers: { "user-agent": "optiq-benchmark (https://github.com/Baukaalm/optiq)" } });
  if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
  await writeFile(join(dir, f), new Uint8Array(await r.arrayBuffer()));
}
await copyFile(join(here, "../../docs/public/logo.svg"), join(dir, "optiq-logo.svg"));
await copyFile(join(here, "../../docs/public/favicon.svg"), join(dir, "optiq-favicon.svg"));

const dist = join(here, "../../dist");
const { optimizeInNode, initNodeCodecs } = await import(join(dist, "node.js"));
await initNodeCodecs();
const { initSvgRenderer } = await import(join(dist, "svg.js"));
const { ssim } = await import(join(dist, "quality.js"));
const { optimize } = await import("svgo/browser");
const m = await initSvgRenderer();
const render = (b) => {
  const p = new m.Resvg(b);
  const fit = p.width >= p.height ? { mode: "width", value: 512 } : { mode: "height", value: 512 };
  p.free();
  const r = new m.Resvg(b, { fitTo: fit, font: { loadSystemFonts: false } });
  const i = r.render();
  const o = { data: new Uint8ClampedArray(i.pixels), width: i.width, height: i.height };
  i.free();
  r.free();
  return o;
};
const rows = [];
for (const f of (await readdir(dir)).filter((x) => x.endsWith(".svg")).sort()) {
  const input = new Uint8Array(await readFile(join(dir, f)));
  const t = performance.now();
  const b = await optimizeInNode(input, { mode: "balanced", preserveMetadata: false });
  const ms = performance.now() - t;
  const l = await optimizeInNode(input, { mode: "lossless", preserveMetadata: false });
  const def = new TextEncoder().encode(optimize(new TextDecoder().decode(input), { multipass: true }).data);
  const a = render(input), d = render(def);
  rows.push({ file: f, in: input.length, balanced: b.report.outputBytes, balancedCodec: b.report.codec, balancedQuality: b.report.qualityMetricName === "exact" ? "exact" : b.report.qualityMetric, ms: Math.round(ms), lossless: l.report.outputBytes, svgoDefault: def.length, svgoDefaultRenderSsim: a.width === d.width && a.height === d.height ? ssim(a, d).ssim : null, warnings: b.report.warnings });
}
await writeFile(join(here, "../results/svg.json"), JSON.stringify({ date: new Date().toISOString(), rows }, null, 2) + "\n");
const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
for (const r of rows) console.log(`${r.file.padEnd(32)} ${String(r.in).padStart(7)} → ${String(r.balanced).padStart(7)} (${((1 - r.balanced / r.in) * 100).toFixed(1).padStart(5)}%, ${r.balancedCodec}, ${r.balancedQuality === "exact" ? "exact" : r.balancedQuality.toFixed(4)}, ${r.ms} ms)  lossless ${((1 - r.lossless / r.in) * 100).toFixed(1)}%  svgo default ${((1 - r.svgoDefault / r.in) * 100).toFixed(1)}% (render SSIM ${r.svgoDefaultRenderSsim?.toFixed(4)})`);
const p = (k) => `${((1 - sum(k) / sum("in")) * 100).toFixed(1)}%`;
console.log(`\ntotal: balanced −${p("balanced")}, lossless −${p("lossless")}, SVGO default (unchecked) −${p("svgoDefault")}`);
