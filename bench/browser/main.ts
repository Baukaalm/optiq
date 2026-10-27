import imageCompression from "browser-image-compression";
import { compressImage } from "optiq-image";

type Tool = (file: File) => Promise<Blob>;

async function canvasEncode(file: File, type: string, quality: number): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close();
  return c.convertToBlob({ type, quality });
}

const tools: Record<string, Tool> = {
  "sc-balanced": async (f) => (await compressImage(f, { mode: "balanced" })).blob,
  "sc-visually-lossless": async (f) => (await compressImage(f, { mode: "visually-lossless" })).blob,
  "sc-lossless": async (f) => (await compressImage(f, { mode: "lossless" })).blob,
  // browser-image-compression, main-thread mode (its worker mode loads the library from a CDN by default).
  "bic-maxsize-1mb": (f) => imageCompression(f, { maxSizeMB: 1, useWebWorker: false }),
  "bic-quality-0.8": (f) => imageCompression(f, { initialQuality: 0.8, useWebWorker: false, alwaysKeepResolution: true }),
  "bic-webp-0.8": (f) => imageCompression(f, { initialQuality: 0.8, fileType: "image/webp", useWebWorker: false, alwaysKeepResolution: true }),
  "canvas-webp-0.8": (f) => canvasEncode(f, "image/webp", 0.8),
  "canvas-jpeg-0.8": (f) => canvasEncode(f, "image/jpeg", 0.8),
};

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

declare global {
  interface Window {
    benchOne: (url: string, name: string, tool: string) => Promise<{ base64?: string; bytes?: number; timeMs?: number; type?: string; error?: string }>;
  }
}

window.benchOne = async (url, name, tool) => {
  const file = new File([await (await fetch(url)).blob()], name, { type: name.endsWith(".png") ? "image/png" : "image/jpeg" });
  try {
    const t0 = performance.now();
    const out = await tools[tool](file);
    const timeMs = performance.now() - t0;
    return { base64: toBase64(await out.arrayBuffer()), bytes: out.size, timeMs, type: out.type };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};
