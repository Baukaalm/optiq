// Builds the benchmark corpus into bench/corpus/images and writes bench/corpus/manifest.json.
//
// Sources
//  - photo:   Kodak Lossless True Color Image Suite (released by Eastman Kodak for unrestricted use),
//             PNG originals from r0k.us, re-encoded as JPEG q92 (typical camera/phone quality) or kept as PNG.
//  - large:   Unsplash photos via picsum.photos (Unsplash licence), 4032x3024, re-encoded as JPEG q92 with an
//             sRGB ICC profile and EXIF, mimicking a phone upload.
//  - screenshot / text-graphic / transparent-illustration / gradient: rendered locally with Playwright Chromium.
//    Font rendering is platform-dependent, so checksums of these differ across operating systems.
//
// Downloads are cached in bench/corpus/downloads and treated as untrusted input (only decoded by sharp).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { chromium } from "playwright";

const root = fileURLToPath(new URL(".", import.meta.url));
const dl = join(root, "downloads");
const out = join(root, "images");
await mkdir(dl, { recursive: true });
await mkdir(out, { recursive: true });

async function download(url, name) {
  const p = join(dl, name);
  try {
    await stat(p);
    return p;
  } catch {}
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await writeFile(p, Buffer.from(await res.arrayBuffer()));
  return p;
}

const manifest = [];
async function add(file, category, source, buf) {
  await writeFile(join(out, file), buf);
  const m = await sharp(buf).metadata();
  manifest.push({ file, category, source, bytes: buf.length, width: m.width, height: m.height, format: m.format, sha256: createHash("sha256").update(buf).digest("hex") });
  console.log(`${category.padEnd(26)} ${file.padEnd(32)} ${m.width}x${m.height} ${buf.length} B`);
}

// ---- Photographs -------------------------------------------------------------------------------------------------
const KODAK_JPEG = ["01", "03", "05", "07", "13", "15", "20", "23"];
const KODAK_PNG = ["08", "19"];
for (const id of [...KODAK_JPEG, ...KODAK_PNG]) {
  const src = await download(`https://r0k.us/graphics/kodak/kodak/kodim${id}.png`, `kodim${id}.png`);
  const img = sharp(await readFile(src));
  if (KODAK_JPEG.includes(id)) await add(`photo-kodim${id}.jpg`, "photo", `Kodak kodim${id}, JPEG q92 4:2:0 (sharp/libjpeg-turbo)`, await img.jpeg({ quality: 92 }).toBuffer());
  else await add(`photo-kodim${id}.png`, "photo", `Kodak kodim${id}, original PNG`, await img.png({ compressionLevel: 6 }).toBuffer());
}
for (const id of ["1015", "1043", "1050"]) {
  const src = await download(`https://picsum.photos/id/${id}/4032/3024.jpg`, `picsum-${id}-4032x3024.jpg`);
  const buf = await sharp(await readFile(src))
    .jpeg({ quality: 92 })
    .withMetadata({ icc: "srgb", exif: { IFD0: { Make: "Bench", Model: "Phone", Software: "smartcompress corpus" } } })
    .toBuffer();
  await add(`large-picsum${id}.jpg`, "photo-large", `picsum.photos id ${id} (Unsplash), 4032x3024 JPEG q92 + sRGB ICC + EXIF`, buf);
}

// ---- Rendered categories -----------------------------------------------------------------------------------------
const browser = await chromium.launch();
async function render(html, width, height, { transparent = false, scale = 1 } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await page.setContent(html, { waitUntil: "load" });
  const buf = await page.screenshot({ type: "png", omitBackground: transparent });
  await page.close();
  return buf;
}
const lorem =
  "SmartCompress chooses the smallest encoding that satisfies an explicit quality constraint. Screenshots and text-heavy graphics contain sharp edges and flat colours, where lossless or high-fidelity encoders often beat photographic codecs. ";

const dashboard = `<style>body{margin:0;font:14px system-ui;background:#f3f4f6;color:#111}nav{background:#111827;color:#fff;padding:14px 20px;font-weight:600}
.grid{display:grid;grid-template-columns:220px 1fr;min-height:100vh}aside{background:#fff;border-right:1px solid #e5e7eb;padding:16px}aside div{padding:8px;border-radius:6px}aside div:nth-child(2){background:#eef2ff;color:#3730a3}
main{padding:20px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px}.card b{font-size:24px;display:block;margin-top:6px}
table{width:100%;border-collapse:collapse;background:#fff;margin-top:16px;border-radius:10px}td,th{padding:9px 12px;border-bottom:1px solid #f0f0f0;text-align:left}th{background:#f9fafb;font-weight:600}
.bar{height:8px;background:#e5e7eb;border-radius:4px}.bar i{display:block;height:8px;border-radius:4px;background:linear-gradient(90deg,#6366f1,#22d3ee)}</style>
<nav>Acme Analytics</nav><div class="grid"><aside>${["Overview", "Uploads", "Storage", "Billing", "Team", "Settings"].map((x) => `<div>${x}</div>`).join("")}</aside><main>
<div class="cards">${["Uploads", "Bytes saved", "Median ratio", "Errors"].map((x, i) => `<div class="card">${x}<b>${[12840, "38.2 GB", "0.61", 3][i]}</b></div>`).join("")}</div>
<table><tr><th>File</th><th>Format</th><th>Original</th><th>Optimized</th><th>Saved</th></tr>${Array.from({ length: 14 }, (_, i) => `<tr><td>IMG_${4021 + i}.jpg</td><td>${["webp", "avif", "jpeg"][i % 3]}</td><td>${(3.1 + i * 0.17).toFixed(2)} MB</td><td>${(1.2 + i * 0.05).toFixed(2)} MB</td><td><div class="bar"><i style="width:${40 + ((i * 7) % 50)}%"></i></div></td></tr>`).join("")}</table></main></div>`;

const code = `<style>body{margin:0;background:#1e1e1e;color:#d4d4d4;font:13px/1.55 ui-monospace,Menlo,monospace;padding:16px}.k{color:#569cd6}.s{color:#ce9178}.c{color:#6a9955}.n{color:#b5cea8}.f{color:#dcdcaa}</style>
${Array.from({ length: 48 }, (_, i) => `<div><span class="n">${String(i + 1).padStart(3)}</span>  ${["<span class=k>export async function</span> <span class=f>compressImage</span>(input, options) {", "  <span class=c>// Validate input and detect the real format from magic bytes</span>", "  <span class=k>const</span> bytes = <span class=k>new</span> Uint8Array(<span class=k>await</span> input.arrayBuffer());", "  <span class=k>if</span> (bytes.length > limit) <span class=k>throw new</span> Error(<span class=s>'too large'</span>);", "  <span class=k>return</span> worker.run({ bytes, options, quality: <span class=n>0.975</span> });", "}"][i % 6]}</div>`).join("")}`;

const docs = `<style>body{margin:0;background:#fff;color:#1f2937;font:15px/1.6 Georgia,serif;padding:32px 48px}h1{font:700 28px system-ui}h2{font:600 20px system-ui;margin-top:20px}p{margin:8px 0;text-align:justify}</style>
<h1>Image optimization for uploads</h1>${Array.from({ length: 6 }, (_, i) => `<h2>${i + 1}. Section heading</h2><p>${lorem.repeat(3)}</p>`).join("")}`;

const slide = `<style>body{margin:0;width:1600px;height:900px;background:#0b3d91;color:#fff;font:600 44px system-ui;display:flex;flex-direction:column;justify-content:center;padding:80px;box-sizing:border-box}ul{font-weight:400;font-size:32px;line-height:1.6}</style>
<div>Quarterly results</div><ul><li>Upload volume +41% year over year</li><li>Median image size reduced from 3.2 MB to 1.1 MB</li><li>p95 compression latency 2.4 s on mid-range laptops</li><li>No quality regressions reported</li></ul>`;

await add("screenshot-dashboard.png", "screenshot", "Playwright render of an HTML dashboard, 1440x900 @2x", await render(dashboard, 1440, 900, { scale: 2 }));
await add("screenshot-code.png", "screenshot", "Playwright render of a dark code editor, 1280x800", await render(code, 1280, 800));
await add("text-docs.png", "text-graphic", "Playwright render of a text document, 1100x1400", await render(docs, 1100, 1400));
await add("text-slide.png", "text-graphic", "Playwright render of a presentation slide, 1600x900", await render(slide, 1600, 900));

const svgShapes = (seed) => {
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: 14 }, (_, i) => {
    const hue = Math.floor(r() * 360);
    if (i % 3 === 0) return `<circle cx="${r() * 900}" cy="${r() * 700}" r="${40 + r() * 120}" fill="hsla(${hue},70%,55%,${0.5 + r() * 0.5})"/>`;
    if (i % 3 === 1) return `<rect x="${r() * 800}" y="${r() * 600}" width="${60 + r() * 200}" height="${60 + r() * 160}" rx="18" fill="url(#g${i % 2})" stroke="#1f2937" stroke-width="4"/>`;
    return `<path d="M${r() * 900},${r() * 700} Q${r() * 900},${r() * 700} ${r() * 900},${r() * 700}" stroke="hsl(${hue},60%,40%)" stroke-width="10" fill="none" stroke-linecap="round"/>`;
  }).join("");
};
for (const [i, seed] of [[1, 7], [2, 42], [3, 1234]]) {
  const html = `<style>html,body{margin:0;background:transparent}</style><svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800"><defs><linearGradient id="g0"><stop offset="0" stop-color="#f59e0b"/><stop offset="1" stop-color="#ef4444"/></linearGradient><linearGradient id="g1" x2="0" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#6366f1" stop-opacity="0.4"/></linearGradient><filter id="sh"><feDropShadow dx="6" dy="8" stdDeviation="8" flood-opacity="0.35"/></filter></defs><g filter="url(#sh)">${svgShapes(seed)}</g></svg>`;
  await add(`transparent-illustration-${i}.png`, "transparent-illustration", `Playwright render of SVG shapes with alpha and drop shadows (seed ${seed}), transparent background`, await render(html, 1000, 800, { transparent: true }));
}
const icon = `<style>html,body{margin:0;background:transparent}</style><svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect x="32" y="32" width="448" height="448" rx="96" fill="#2563eb"/><path d="M150 330 L230 230 L290 290 L360 190" stroke="#fff" stroke-width="36" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
await add("transparent-icon.png", "transparent-illustration", "Playwright render of an app icon, 512x512, transparent corners", await render(icon, 512, 512, { transparent: true }));

const gradients = [
  ["gradient-linear.png", "linear-gradient(135deg,#0f172a 0%,#7c3aed 45%,#f472b6 100%)", 1920, 1080],
  ["gradient-radial.png", "radial-gradient(circle at 30% 30%,#fde68a,#f97316 40%,#1e1b4b 100%)", 1600, 1200],
  ["gradient-sky.png", "linear-gradient(180deg,#0c4a6e 0%,#38bdf8 60%,#fef3c7 100%)", 1280, 1280],
];
for (const [file, css, w, h] of gradients) {
  await add(file, "gradient", `Playwright render of CSS ${css.split("(")[0]}, ${w}x${h}`, await render(`<style>html,body{margin:0;height:100%;background:${css}}</style>`, w, h));
}
await browser.close();
await writeFile(join(root, "manifest.json"), JSON.stringify({ generatedBy: "bench/corpus/build.mjs", platform: `${process.platform}-${process.arch}`, images: manifest }, null, 2) + "\n");
console.log(`\n${manifest.length} images -> bench/corpus/images, manifest.json written`);
