import { compressImage, type CompressionResult } from "optiq-image";

async function canvasImage(kind: "photo" | "screenshot" | "transparent", w: number, h: number, type: string, quality?: number): Promise<Blob> {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d")!;
  if (kind === "photo") {
    const g = ctx.createRadialGradient(w * 0.3, h * 0.3, 10, w / 2, h / 2, Math.max(w, h));
    g.addColorStop(0, "#f4d03f"); g.addColorStop(0.5, "#16a085"); g.addColorStop(1, "#2c3e50");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    let s = 1;
    for (let i = 0; i < img.data.length; i += 4) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const n = ((s >> 16) % 9) - 4;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
  } else if (kind === "screenshot") {
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#1f2937"; ctx.fillRect(0, 0, w, 48);
    ctx.fillStyle = "#111"; ctx.font = "14px sans-serif";
    for (let y = 80; y < h - 10; y += 20) ctx.fillText("The quick brown fox jumps over the lazy dog 0123456789", 20, y);
  } else {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(220,40,40,0.8)"; ctx.beginPath(); ctx.arc(w / 2, h / 2, Math.min(w, h) / 3, 0, Math.PI * 2); ctx.fill();
  }
  return c.convertToBlob({ type, quality });
}

async function pixels(blob: Blob): Promise<{ w: number; h: number; data: Uint8ClampedArray }> {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  return { w: bmp.width, h: bmp.height, data: ctx.getImageData(0, 0, bmp.width, bmp.height).data };
}

type Case = { name: string; run: () => Promise<Record<string, unknown>> };
const summary = (r: CompressionResult) => ({ in: r.originalFormat, out: r.outputFormat, mime: r.blob.type, inBytes: r.originalBytes, outBytes: r.outputBytes, q: r.qualityMetric, codec: r.codec, ms: r.durationMs, fallbacks: r.fallbacks, warnings: r.warnings, category: r.category });

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const cases: Case[] = [
  {
    name: "jpeg photo (balanced) -> smaller, decodable, correct MIME",
    async run() {
      const input = await canvasImage("photo", 1200, 800, "image/jpeg", 0.95);
      const r = await compressImage(new File([input], "photo.jpg", { type: "image/jpeg" }));
      const px = await pixels(r.blob);
      assert(px.w === 1200 && px.h === 800, "dims");
      assert(r.outputBytes < r.originalBytes, "not smaller");
      assert(r.blob.type === `image/${r.outputFormat === "jpeg" ? "jpeg" : r.outputFormat}`, "mime");
      assert(r.qualityMetric! >= 0.975, "quality");
      return summary(r);
    },
  },
  {
    name: "svg from an editor -> smaller, still SVG, verified by rendering in the worker",
    async run() {
      const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Created with an editor -->\n<svg xmlns="http://www.w3.org/2000/svg" width="120.000000" height="80.000000" viewBox="0 0 120.000000 80.000000"><g><g><rect id="badge" x="10.000000" y="10.000000" width="100.000000" height="60.000000" rx="8.000000" style="fill:#3366cc;fill-opacity:1;stroke:none"/><circle cx="60.000000" cy="40.000000" r="6.000000" fill="#ff8800"/></g></g></svg>`;
      const r = await compressImage(new File([svg], "logo.svg", { type: "image/svg+xml" }));
      assert(r.outputFormat === "svg" && r.blob.type === "image/svg+xml", "format");
      assert(r.codec === "svgo", `codec ${r.codec}`);
      assert(r.outputBytes < r.originalBytes * 0.8, "not smaller");
      assert(r.qualityMetric! >= 0.995, "quality");
      const text = await r.blob.text();
      assert(text.includes('id="badge"') && text.includes("viewBox"), "ids/viewBox kept");
      return summary(r);
    },
  },
  {
    name: "png screenshot (lossless) -> pixel identical in the browser decoder",
    async run() {
      const input = await canvasImage("screenshot", 900, 600, "image/png");
      const r = await compressImage(input, { mode: "lossless" });
      const a = await pixels(input);
      const b = await pixels(r.blob);
      assert(a.data.length === b.data.length && a.data.every((v, i) => v === b.data[i]), "pixels differ");
      return summary(r);
    },
  },
  {
    name: "transparent png -> alpha kept, never jpeg",
    async run() {
      const input = await canvasImage("transparent", 400, 300, "image/png");
      const r = await compressImage(input, { mode: "visually-lossless" });
      assert(r.outputFormat !== "jpeg", "jpeg chosen for alpha image");
      const b = await pixels(r.blob);
      assert(b.data[3] === 0, `corner should stay transparent: ${JSON.stringify(r.candidates.map((c) => [c.codec, c.settings.quality, c.bytes, c.quality, c.passed]))} corner=${Array.from(b.data.slice(0, 4))}`);
      return summary(r);
    },
  },
  {
    name: "webp input + avif allowed -> output decodes natively",
    async run() {
      const input = await canvasImage("photo", 640, 480, "image/webp", 0.95);
      const r = await compressImage(input, { autoFormats: ["avif", "webp"], preserveMetadata: false });
      const px = await pixels(r.blob);
      assert(px.w === 640, "decode");
      return summary(r);
    },
  },
  {
    name: "explicit AVIF output (sRGB-tagged) decodes natively with matching colour",
    async run() {
      const input = await canvasImage("photo", 640, 480, "image/png");
      const r = await compressImage(input, { targetFormat: "avif", mode: "visually-lossless", preserveMetadata: false });
      assert(r.outputFormat === "avif" && r.blob.type === "image/avif", "avif");
      const a = await pixels(input);
      const b = await pixels(r.blob);
      let diff = 0;
      for (let i = 0; i < a.data.length; i += 4) diff += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      const meanAbs = diff / (a.data.length / 4) / 3;
      assert(meanAbs < 3, `mean abs diff ${meanAbs}`);
      return { ...summary(r), meanAbsDiffInBrowser: meanAbs };
    },
  },
  {
    name: "wrong extension and MIME are ignored",
    async run() {
      const input = await canvasImage("screenshot", 300, 200, "image/png");
      const r = await compressImage(new File([input], "x.jpg", { type: "image/jpeg" }), { mode: "lossless" });
      assert(r.originalFormat === "png", "sniffing");
      assert(r.fileName.endsWith(".png") || r.fileName.endsWith(".webp"), r.fileName);
      return summary(r);
    },
  },
  {
    name: "unsupported input -> typed error",
    async run() {
      try {
        await compressImage(new Blob(["hello world, not an image"], { type: "image/png" }));
      } catch (e) {
        const code = (e as { code?: string }).code;
        assert(code === "UNSUPPORTED_FORMAT", String(code));
        return { code };
      }
      throw new Error("expected rejection");
    },
  },
  {
    name: "cancellation stops a 12 MP job quickly; main thread stays responsive",
    async run() {
      const input = await canvasImage("photo", 4000, 3000, "image/png");
      const ac = new AbortController();
      let maxGap = 0;
      let last = performance.now();
      const timer = setInterval(() => {
        const t = performance.now();
        maxGap = Math.max(maxGap, t - last);
        last = t;
      }, 10);
      const p = compressImage(input, { mode: "visually-lossless", signal: ac.signal });
      await new Promise((r) => setTimeout(r, 1500));
      const t0 = performance.now();
      ac.abort();
      let code: string | undefined;
      try {
        await p;
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      const abortLatency = performance.now() - t0;
      clearInterval(timer);
      assert(code === "ABORTED", `expected ABORTED, got ${code}`);
      assert(abortLatency < 100, `abort latency ${abortLatency}`);
      assert(maxGap < 150, `main thread blocked for ${maxGap} ms`);
      return { abortLatencyMs: Math.round(abortLatency), maxMainThreadGapMs: Math.round(maxGap) };
    },
  },
  {
    name: "large 12 MP photo completes (balanced)",
    async run() {
      const input = await canvasImage("photo", 4000, 3000, "image/jpeg", 0.92);
      const r = await compressImage(input, { mode: "balanced" });
      return { ...summary(r), candidates: r.candidates.length };
    },
  },
];

declare global {
  interface Window {
    runSuite: (only?: string) => Promise<{ name: string; ok: boolean; detail: unknown }[]>;
  }
}

window.runSuite = async (only?: string) => {
  const out: { name: string; ok: boolean; detail: unknown }[] = [];
  for (const c of cases) {
    if (only && !c.name.includes(only)) continue;
    try {
      out.push({ name: c.name, ok: true, detail: await c.run() });
    } catch (e) {
      out.push({ name: c.name, ok: false, detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    }
  }
  return out;
};
