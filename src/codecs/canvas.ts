import type { RawImage } from "../pixels.js";
import type { DecodableFormat, OutputFormat } from "../types.js";
import type { CodecBackend, EncodeSettings } from "./types.js";

const MIME: Record<OutputFormat, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif" };

export function canvasBackendAvailable(): boolean {
  return typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function";
}

function context(width: number, height: number): OffscreenCanvasRenderingContext2D {
  const ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas context unavailable");
  return ctx;
}

/**
 * Browser-native codecs through OffscreenCanvas. Used only as a reported fallback when a WASM codec cannot load
 * (e.g. CSP without 'wasm-unsafe-eval'). Limitations: canvas stores premultiplied alpha, so semi-transparent
 * pixels may not round-trip exactly; encoder settings other than quality are not available; AVIF/WebP encoding
 * depends on the browser.
 */
export function createCanvasBackend(): CodecBackend {
  return {
    name: "canvas",
    async decode(format: Exclude<DecodableFormat, "gif">, bytes: Uint8Array) {
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: `image/${format}` }), {
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
        imageOrientation: "none" as ImageOrientation,
      });
      try {
        const ctx = context(bitmap.width, bitmap.height);
        ctx.drawImage(bitmap, 0, 0);
        const d = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
        return { data: d.data, width: d.width, height: d.height };
      } finally {
        bitmap.close();
      }
    },
    async encode(format: OutputFormat, img: RawImage, s: EncodeSettings) {
      if (s.lossless === true && format !== "png") throw new Error(`Canvas cannot encode lossless ${format}`);
      const canvas = new OffscreenCanvas(img.width, img.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("2D canvas context unavailable");
      ctx.putImageData(new ImageData(img.data.slice() as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
      const quality = typeof s.quality === "number" ? s.quality / 100 : undefined;
      const blob = await canvas.convertToBlob({ type: MIME[format], quality });
      // Browsers silently fall back to PNG for unsupported types.
      if (blob.type !== MIME[format]) throw new Error(`Browser canvas cannot encode ${format}`);
      return new Uint8Array(await blob.arrayBuffer());
    },
    async resize(img: RawImage, width: number, height: number) {
      const src = new OffscreenCanvas(img.width, img.height);
      src.getContext("2d")!.putImageData(new ImageData(img.data.slice() as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
      const ctx = context(width, height);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(src, 0, 0, width, height);
      const d = ctx.getImageData(0, 0, width, height);
      return { data: d.data, width, height };
    },
    codecName(format: OutputFormat) {
      return `canvas-${format}`;
    },
  };
}
