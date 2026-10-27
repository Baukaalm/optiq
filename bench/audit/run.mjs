// Independent audit of Optiq outputs on edge-case fixtures derived from the benchmark corpus.
//
// Every check uses tooling *other than* Optiq's own decoders and metric:
//  - lossless claims: decode input and output with libvips (sharp) and compare raw pixels (16-bit when the input is 16-bit);
//  - perceptual quality: ssim.js (Gaussian "original" SSIM on luma) after flattening alpha on white, plus PSNR;
//  - metadata: sharp.metadata() of the output (EXIF, GPS IFD pointer, ICC bytes, XMP, orientation).
// Also records wall time per pipeline phase through the engine's onTiming hook.
//
// Usage: node bench/audit/run.mjs [--only substring]      (needs `pnpm bench:corpus` and `pnpm build`)
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { initNodeCodecs, optimizeInNode } from "../../dist/node.js";
import { parseIcc } from "../../dist/container/icc.js";
import { pngChunk } from "../../dist/container/png.js";

const require = createRequire(import.meta.url);
const { ssim: refSsim } = require("ssim.js");
const here = fileURLToPath(new URL(".", import.meta.url));
const corpus = join(here, "../corpus/images");
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
sharp.concurrency(1);

const src = (f) => readFile(join(corpus, f));
const XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Audit</dc:creator><dc:description>${"x".repeat(4000)}</dc:description></rdf:Description></rdf:RDF></x:xmpmeta>`;

async function withGama(png) {
  const b = new Uint8Array(png);
  const ihdrEnd = 8 + 25;
  const gama = pngChunk("gAMA", new Uint8Array([0, 0, 0xb1, 0x8f])); // 1/2.2
  return Buffer.concat([b.subarray(0, ihdrEnd), gama, b.subarray(ihdrEnd)]);
}

async function fixtures() {
  const kodim = await src("photo-kodim23.jpg");
  const kodimPng = await src("photo-kodim19.png");
  const large = await src("large-picsum1015.jpg");
  const shot = await src("screenshot-code.png");
  const icon = await src("transparent-icon.png");
  const grad = await src("gradient-sky.png");
  const two = await sharp(kodim).resize(256, 171).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const anim = Buffer.concat([two.data, Buffer.from(two.data).reverse()]);
  return {
    "phone-12mp-orient6-p3-gps-xmp.jpg": await sharp(large)
      .jpeg({ quality: 93 })
      .withMetadata({ orientation: 6, icc: "p3", exif: { IFD0: { Make: "Audit", Model: "Phone" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } } })
      .withXmp(XMP)
      .toBuffer(),
    "photo-srgb-exif.jpg": await sharp(kodim).jpeg({ quality: 92 }).withMetadata({ icc: "srgb", exif: { IFD0: { Copyright: "Audit" } } }).toBuffer(),
    "photo-p3.png": await sharp(kodimPng).png().withMetadata({ icc: "p3" }).toBuffer(),
    "gray.jpg": await sharp(kodim).grayscale().jpeg({ quality: 90 }).toBuffer(),
    "already-compressed-q55.jpg": await sharp(kodim).jpeg({ quality: 55, mozjpeg: true }).toBuffer(),
    "palette-alpha.png": await sharp(icon).png({ palette: true, colours: 32 }).toBuffer(),
    "rgb16.png": await sharp(grad).toColourspace("rgb16").png().toBuffer(),
    "gama.png": await withGama(await sharp(shot).png().toBuffer()),
    "tiny-16.png": await sharp(icon).resize(16, 16).png().toBuffer(),
    "lossy-q50.webp": await sharp(kodim).webp({ quality: 50 }).toBuffer(),
    "lossless.webp": await sharp(shot).webp({ lossless: true }).toBuffer(),
    "static.gif": await sharp(shot).resize(400).gif().toBuffer(),
    "animated.gif": await sharp(anim, { raw: { width: two.info.width, height: two.info.height * 2, channels: 4, pageHeight: two.info.height } }).gif({ loop: 0 }).toBuffer(),
    "cmyk.jpg": await sharp(kodim).toColourspace("cmyk").jpeg({ quality: 90 }).toBuffer(),
    "photo.avif": await sharp(kodim).avif({ quality: 60 }).toBuffer(),
    "screenshot.png": shot,
    "transparent.png": icon,
  };
}

const VARIANTS = {
  "lossless": { mode: "lossless" },
  "lossless-strip": { mode: "lossless", preserveMetadata: false },
  "visually-lossless": { mode: "visually-lossless" },
  "balanced": { mode: "balanced" },
  "balanced-strip": { mode: "balanced", preserveMetadata: false },
  "balanced-1024": { mode: "balanced", maxWidthOrHeight: 1024 },
  "balanced-webp": { mode: "balanced", targetFormat: "webp" },
};

async function meta(buf) {
  const m = await sharp(buf, { animated: true, limitInputPixels: false }).metadata();
  const icc = m.icc ? parseIcc(new Uint8Array(m.icc)) : undefined;
  const ex = m.exif;
  return {
    format: m.format,
    pages: m.pages ?? 1,
    exif: !!ex,
    gps: !!ex && (ex.includes(Buffer.from([0x88, 0x25])) || ex.includes(Buffer.from([0x25, 0x88]))),
    icc: m.icc ? Buffer.from(m.icc) : undefined,
    iccDesc: icc?.description,
    iccSrgb: icc?.isSrgb ?? false,
    xmp: !!m.xmp,
    orientation: m.orientation ?? 1,
    depth: m.depth,
    displayW: (m.orientation ?? 1) >= 5 ? m.height : m.width,
    displayH: (m.orientation ?? 1) >= 5 ? m.width : (m.pageHeight ?? m.height),
  };
}

/** Oriented raw pixels decoded by libvips. */
async function raw(buf, depth16) {
  let s = sharp(buf, { limitInputPixels: false }).rotate().ensureAlpha();
  if (depth16) s = s.toColourspace("rgb16");
  const { data, info } = await s.raw({ depth: depth16 ? "ushort" : "uchar" }).toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function flatRgba(buf) {
  const { data, info } = await sharp(buf, { limitInputPixels: false }).rotate().flatten({ background: "#ffffff" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

function psnr(a, b) {
  let se = 0;
  for (let i = 0; i < a.data.length; i++) if (i % 4 !== 3) se += (a.data[i] - b.data[i]) ** 2;
  const mse = se / ((a.data.length / 4) * 3);
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

await initNodeCodecs();
const fx = await fixtures();
const findings = [];
const rows = [];
const phases = {};
const flag = (row, kind, detail) => {
  findings.push({ fixture: row.fixture, variant: row.variant, kind, detail });
  row.flags.push(kind);
};

for (const [name, input] of Object.entries(fx)) {
  if (only && !name.includes(only)) continue;
  const inMeta = await meta(input);
  for (const [variant, options] of Object.entries(VARIANTS)) {
    const row = { fixture: name, variant, originalBytes: input.length, flags: [] };
    rows.push(row);
    const timing = {};
    let out;
    try {
      const t = performance.now();
      out = await optimizeInNode(new Uint8Array(input), options, { onTiming: (p, ms) => (timing[p] = (timing[p] ?? 0) + ms) });
      row.timeMs = performance.now() - t;
    } catch (e) {
      row.error = `${e.code ?? "ERR"}: ${e.message}`;
      console.log(`${name.padEnd(36)} ${variant.padEnd(18)} ${row.error.slice(0, 110)}`);
      continue;
    }
    const r = out.report;
    const outBuf = Buffer.from(out.bytes ?? input);
    Object.assign(row, { bytes: outBuf.length, outFormat: r.outputFormat, usedOriginal: r.usedOriginal, codec: r.codec, category: r.category, metric: r.qualityMetricName, quality: r.qualityMetric, constraintsMet: r.constraintsMet, metadata: r.metadata, warnings: r.warnings, timing });
    for (const [p, ms] of Object.entries(timing)) phases[p] = (phases[p] ?? 0) + ms;
    phases.total = (phases.total ?? 0) + row.timeMs;

    // 1. Size.
    if (outBuf.length > input.length) flag(row, "larger-than-original", `${input.length} -> ${outBuf.length} (${options.targetFormat ? "explicit targetFormat" : options.maxWidthOrHeight ? "resize" : "auto"})`);

    // 2. Pixels / quality, measured independently.
    const outMeta = await meta(outBuf);
    const resized = !!options.maxWidthOrHeight && Math.max(inMeta.displayW, inMeta.displayH) > options.maxWidthOrHeight;
    if (inMeta.pages > 1 && outMeta.pages !== inMeta.pages && options.preserveAnimation !== false) flag(row, "animation-lost", `${inMeta.pages} -> ${outMeta.pages} frames`);
    if (!resized && (outMeta.displayW !== inMeta.displayW || outMeta.displayH !== inMeta.displayH)) flag(row, "display-size-changed", `${inMeta.displayW}x${inMeta.displayH} -> ${outMeta.displayW}x${outMeta.displayH}`);
    if (!resized && inMeta.pages === 1) {
      if (r.qualityMetricName === "exact") {
        const deep = inMeta.depth === "ushort";
        const [a, b] = await Promise.all([raw(input, deep), raw(outBuf, deep)]);
        row.exactIndependent = a.data.equals(b.data);
        if (!row.exactIndependent) {
          const decoderDependent = inMeta.format === "jpeg" && outMeta.format !== "jpeg";
          flag(row, decoderDependent ? "exact-only-for-mozjpeg-decoder" : "lossless-mismatch-libvips", `${inMeta.format}->${outMeta.format}${deep ? " (16-bit compared)" : ""}`);
        }
      } else {
        const [a, b] = await Promise.all([flatRgba(input), flatRgba(outBuf)]);
        row.ssimRef = refSsim(a, b, { ssim: "original" }).mssim;
        row.psnr = psnr(a, b);
        const thr = variant === "visually-lossless" ? 0.99 : 0.975;
        if (row.ssimRef < thr - 0.01) flag(row, "reference-ssim-below-threshold", `ssim.js ${row.ssimRef.toFixed(4)} vs engine ${r.qualityMetric?.toFixed(4)} (threshold ${thr})`);
      }
    }

    // 3. Metadata.
    const keep = options.preserveMetadata !== false;
    if (keep && inMeta.exif && !outMeta.exif) flag(row, "exif-lost", `report: ${r.metadata.exif}`);
    if (keep && inMeta.xmp && !outMeta.xmp) flag(row, "xmp-lost", `report: ${r.metadata.xmp}`);
    if (!keep && outMeta.gps) flag(row, "gps-leaked", "preserveMetadata: false but GPS IFD present");
    if (inMeta.icc && !inMeta.iccSrgb && !(outMeta.icc && outMeta.icc.equals(inMeta.icc))) flag(row, "non-srgb-icc-lost", `${inMeta.iccDesc} -> ${outMeta.iccDesc ?? "none"}`);
    if (keep && inMeta.icc && inMeta.iccSrgb && !outMeta.icc && outMeta.format !== "heif") flag(row, "srgb-icc-dropped-while-preserving", `output ${outMeta.format}`);
    if (r.metadata.exif === "kept" && !outMeta.exif) flag(row, "report-says-exif-kept-but-missing", "");

    console.log(
      `${name.padEnd(36)} ${variant.padEnd(18)} ${String(input.length).padStart(8)} -> ${String(outBuf.length).padStart(8)} ${String(r.outputFormat).padEnd(5)} ` +
        `${r.qualityMetricName === "exact" ? `exact(libvips:${row.exactIndependent ?? "n/a"})` : `ssim ${r.qualityMetric?.toFixed(4)} ref ${row.ssimRef?.toFixed(4) ?? "n/a"} psnr ${row.psnr?.toFixed(1) ?? "n/a"}`} ${Math.round(row.timeMs)}ms ${row.flags.join(",")}`,
    );
  }
}

const out = join(here, "../results");
await mkdir(out, { recursive: true });
await writeFile(join(out, "audit.json"), JSON.stringify({ date: new Date().toISOString(), node: process.version, phases, findings, rows }, null, 2) + "\n");
console.log("\nTime by phase (all runs):");
const total = phases.total;
for (const [p, ms] of Object.entries(phases).sort((a, b) => b[1] - a[1])) console.log(`  ${p.padEnd(14)} ${(ms / 1000).toFixed(1).padStart(7)} s  ${((100 * ms) / total).toFixed(1).padStart(5)}%`);
const byKind = {};
for (const f of findings) (byKind[f.kind] ??= []).push(`${f.fixture} / ${f.variant}: ${f.detail}`);
console.log(`\nFindings: ${findings.length}`);
for (const [k, v] of Object.entries(byKind)) console.log(`- ${k} (${v.length})\n    ${v.join("\n    ")}`);
