// Larger corpus for fitting and validating the quality predictor (separate from the 24-image benchmark corpus).
//  - photos: Unsplash images via picsum.photos (Unsplash licence), 1024x768 JPEG as served
//  - graphics: rendered with Playwright from randomised templates (dashboards, code, documents, slides,
//    transparent illustrations, icons, gradients)
// Split: deterministic 70/30 train/test by hashing the file name. Usage: node bench/predictor/build-corpus.mjs
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = join(here, "images");
const dl = join(here, "downloads");
await mkdir(out, { recursive: true });
await mkdir(dl, { recursive: true });
const PHOTOS = Number(process.env.PHOTOS ?? 200);
const manifest = [];
const split = (name) => (parseInt(createHash("sha1").update(name).digest("hex").slice(0, 8), 16) % 100 < 70 ? "train" : "test");
const add = (file, category, source, bytes) => manifest.push({ file, category, source, bytes, split: split(file) });

// ---- photos ----
const list = [];
for (let page = 1; list.length < PHOTOS * 1.2 && page < 10; page++) {
  const r = await fetch(`https://picsum.photos/v2/list?page=${page}&limit=100`);
  list.push(...(await r.json()));
}
let next = 0;
async function fetchOne() {
  while (next < list.length && manifest.filter((m) => m.category === "photo").length < PHOTOS) {
    const item = list[next++];
    const file = `photo-${item.id}.jpg`;
    const p = join(out, file);
    try {
      await stat(p);
    } catch {
      const r = await fetch(`https://picsum.photos/id/${item.id}/1024/768.jpg`, { redirect: "follow" });
      if (!r.ok) continue;
      await writeFile(p, Buffer.from(await r.arrayBuffer()));
    }
    add(file, "photo", `picsum ${item.id} by ${item.author} (${item.url})`, (await stat(p)).size);
  }
}
await Promise.all(Array.from({ length: 8 }, fetchOne));
console.log(`photos: ${manifest.length}`);

// ---- graphics ----
let s = 12345;
const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(r() * a.length)];
const hue = () => Math.floor(r() * 360);
const browser = await chromium.launch();
async function render(file, category, html, width, height, transparent = false) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(html, { waitUntil: "load" });
  const buf = await page.screenshot({ type: "png", omitBackground: transparent });
  await page.close();
  await writeFile(join(out, file), buf);
  add(file, category, "rendered (Playwright)", buf.length);
}
const words = "optimise image upload quality codec browser worker metric compress format pixel alpha colour profile threshold candidate search budget".split(" ");
const sentence = (n) => Array.from({ length: n }, () => pick(words)).join(" ");

for (let i = 0; i < 25; i++) {
  const dark = r() < 0.4, h = hue();
  const bg = dark ? "#111418" : "#f5f6f8", fg = dark ? "#e6e6e6" : "#1a1a1a", card = dark ? "#1b1f24" : "#fff";
  const rows = Array.from({ length: 6 + Math.floor(r() * 10) }, (_, k) => `<tr><td>${sentence(2)}</td><td>${(r() * 1000).toFixed(1)}</td><td><div style="height:8px;width:${20 + r() * 80}%;background:hsl(${h},70%,55%);border-radius:4px"></div></td></tr>`).join("");
  await render(`dashboard-${i}.png`, "screenshot", `<body style="margin:0;font:14px system-ui;background:${bg};color:${fg}"><div style="background:hsl(${h},40%,20%);color:#fff;padding:14px">Analytics ${i}</div><div style="display:flex;gap:12px;padding:16px">${Array.from({ length: 4 }, () => `<div style="flex:1;background:${card};border-radius:10px;padding:12px">${pick(words)}<b style="display:block;font-size:22px">${Math.floor(r() * 99999)}</b></div>`).join("")}</div><table style="margin:0 16px;width:calc(100% - 32px);background:${card};border-collapse:collapse">${rows}</table></body>`, pick([1024, 1280]), pick([640, 768, 800]));
}
for (let i = 0; i < 15; i++) {
  const dark = r() < 0.7;
  const lines = Array.from({ length: 40 }, (_, k) => `<div><span style="opacity:.5">${String(k + 1).padStart(3)}</span>  <span style="color:hsl(${hue()},60%,${dark ? 70 : 35}%)">${pick(["const", "function", "return", "await", "if"])}</span> ${sentence(3 + Math.floor(r() * 5))}</div>`).join("");
  await render(`code-${i}.png`, "screenshot", `<body style="margin:0;padding:14px;background:${dark ? "#1e1e1e" : "#fbfbfb"};color:${dark ? "#d4d4d4" : "#333"};font:${12 + Math.floor(r() * 3)}px ui-monospace,Menlo,monospace">${lines}</body>`, 1024, 768);
}
for (let i = 0; i < 15; i++) {
  const paras = Array.from({ length: 8 }, () => `<p>${sentence(40 + Math.floor(r() * 40))}.</p>`).join("");
  await render(`docs-${i}.png`, "text-graphic", `<body style="margin:0;padding:32px 48px;background:#fff;color:#222;font:${14 + Math.floor(r() * 4)}px/1.6 ${pick(["Georgia,serif", "system-ui", "Helvetica"])}"><h1>${sentence(4)}</h1>${paras}</body>`, 1024, 1200);
}
for (let i = 0; i < 10; i++) {
  const h = hue();
  await render(`slide-${i}.png`, "text-graphic", `<body style="margin:0;width:1280px;height:720px;background:hsl(${h},50%,${r() < 0.5 ? 25 : 92}%);color:${r() < 0.5 ? "#fff" : "#111"};font:600 40px system-ui;padding:70px;box-sizing:border-box">${sentence(4)}<ul style="font-weight:400;font-size:28px">${Array.from({ length: 4 }, () => `<li>${sentence(6)}</li>`).join("")}</ul></body>`, 1280, 720);
}
for (let i = 0; i < 20; i++) {
  const shapes = Array.from({ length: 6 + Math.floor(r() * 10) }, () => {
    const t = r();
    if (t < 0.4) return `<circle cx="${r() * 800}" cy="${r() * 600}" r="${30 + r() * 120}" fill="hsla(${hue()},70%,55%,${0.5 + r() * 0.5})"/>`;
    if (t < 0.7) return `<rect x="${r() * 700}" y="${r() * 500}" width="${50 + r() * 200}" height="${50 + r() * 150}" rx="16" fill="hsl(${hue()},60%,60%)" stroke="#222" stroke-width="${r() * 6}"/>`;
    return `<path d="M${r() * 800},${r() * 600} Q${r() * 800},${r() * 600} ${r() * 800},${r() * 600}" stroke="hsl(${hue()},60%,40%)" stroke-width="${4 + r() * 10}" fill="none" stroke-linecap="round"/>`;
  }).join("");
  const shadow = r() < 0.5 ? `filter="url(#s)"` : "";
  await render(`transparent-${i}.png`, "transparent-illustration", `<style>html,body{margin:0;background:transparent}</style><svg xmlns="http://www.w3.org/2000/svg" width="900" height="700"><defs><filter id="s"><feDropShadow dx="5" dy="7" stdDeviation="7" flood-opacity=".35"/></filter></defs><g ${shadow}>${shapes}</g></svg>`, 900, 700, true);
}
for (let i = 0; i < 10; i++) {
  const h = hue();
  await render(`icon-${i}.png`, "transparent-illustration", `<style>html,body{margin:0;background:transparent}</style><svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect x="32" y="32" width="448" height="448" rx="${40 + r() * 80}" fill="hsl(${h},65%,50%)"/><circle cx="256" cy="256" r="${60 + r() * 100}" fill="none" stroke="#fff" stroke-width="${20 + r() * 30}"/></svg>`, 512, 512, true);
}
for (let i = 0; i < 15; i++) {
  const stops = Array.from({ length: 2 + Math.floor(r() * 3) }, () => `hsl(${hue()},${40 + r() * 50}%,${20 + r() * 60}%)`).join(",");
  const css = r() < 0.5 ? `linear-gradient(${Math.floor(r() * 360)}deg,${stops})` : `radial-gradient(circle at ${Math.floor(r() * 100)}% ${Math.floor(r() * 100)}%,${stops})`;
  await render(`gradient-${i}.png`, "gradient", `<style>html,body{margin:0;height:100%;background:${css}}</style>`, pick([1024, 1280]), pick([768, 800]));
}
await browser.close();
await writeFile(join(here, "manifest.json"), JSON.stringify({ note: "Images are not committed; rebuild with build-corpus.mjs", images: manifest }, null, 2) + "\n");
const counts = {};
for (const m of manifest) counts[`${m.category}/${m.split}`] = (counts[`${m.category}/${m.split}`] ?? 0) + 1;
console.log(manifest.length, "images", counts);
