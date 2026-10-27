import type { RawImage } from "../pixels.js";
import type { DecodableFormat, OutputFormat } from "../types.js";
import type { CodecBackend, EncodeSettings } from "./types.js";

// Each codec is a separate dynamic import so bundlers emit separate chunks and the
// browser downloads only the WASM it actually needs (AVIF alone is ~3.5 MB).
const loaders = {
  jpegEnc: () => import("@jsquash/jpeg/encode.js"),
  jpegDec: () => import("@jsquash/jpeg/decode.js"),
  pngEnc: () => import("@jsquash/png/encode.js"),
  pngDec: () => import("@jsquash/png/decode.js"),
  webpEnc: () => import("@jsquash/webp/encode.js"),
  webpDec: () => import("@jsquash/webp/decode.js"),
  avifEnc: () => import("@jsquash/avif/encode.js"),
  avifDec: () => import("@jsquash/avif/decode.js"),
  oxipng: () => import("@jsquash/oxipng/optimise.js"),
  resize: () => import("@jsquash/resize"),
};

/**
 * jSquash codecs read `data.buffer` directly (ignoring byteOffset) and oxipng checks `instanceof ImageData`,
 * so hand them a real ImageData over a buffer that starts at offset 0.
 */
function toImageData(img: RawImage): ImageData {
  let data = img.data;
  if (data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength) data = data.slice();
  if (typeof ImageData !== "undefined") {
    if (img instanceof ImageData && data === img.data) return img;
    return new ImageData(data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height);
  }
  return { data, width: img.width, height: img.height, colorSpace: "srgb" } as ImageData;
}
const ab = (b: Uint8Array): ArrayBuffer =>
  (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer : b.slice().buffer) as ArrayBuffer;
const raw = (d: { data: Uint8ClampedArray; width: number; height: number }): RawImage => ({ data: d.data, width: d.width, height: d.height });

const num = (s: EncodeSettings, k: string, d: number): number => (typeof s[k] === "number" ? (s[k] as number) : d);
const bool = (s: EncodeSettings, k: string): boolean => s[k] === true;

/**
 * WASM codecs from jSquash (Squoosh builds): MozJPEG, libwebp, libavif (C/C++ via Emscripten),
 * and the Rust crates png, oxipng and resize (via wasm-bindgen).
 */
export function createWasmBackend(): CodecBackend {
  return {
    name: "wasm",
    async decode(format: Exclude<DecodableFormat, "gif">, bytes: Uint8Array) {
      switch (format) {
        case "jpeg":
          return raw(await (await loaders.jpegDec()).default(ab(bytes), { preserveOrientation: false }));
        case "png":
          return raw(await (await loaders.pngDec()).default(ab(bytes)));
        case "webp":
          return raw(await (await loaders.webpDec()).default(ab(bytes)));
        case "avif": {
          const r = await (await loaders.avifDec()).default(ab(bytes), { bitDepth: 8 });
          if (!r) throw new Error("AVIF decoding error");
          return raw(r as ImageData);
        }
      }
    },
    async encode(format: OutputFormat, img: RawImage, s: EncodeSettings) {
      let out: ArrayBuffer;
      switch (format) {
        case "jpeg": {
          const sub444 = s.chroma === "444";
          out = await (await loaders.jpegEnc()).default(toImageData(img), {
            quality: num(s, "quality", 75),
            progressive: true,
            optimize_coding: true,
            auto_subsample: !sub444,
            chroma_subsample: sub444 ? 1 : 2,
            trellis_multipass: bool(s, "trellisMultipass"),
          });
          break;
        }
        case "webp":
          out = await (await loaders.webpEnc()).default(toImageData(img), {
            quality: num(s, "quality", 75),
            lossless: bool(s, "lossless") ? 1 : 0,
            method: num(s, "method", 4),
            exact: bool(s, "exact") ? 1 : 0,
            use_sharp_yuv: bool(s, "sharpYuv") ? 1 : 0,
            alpha_quality: 100,
          });
          break;
        case "avif":
          out = await (await loaders.avifEnc()).default(toImageData(img), {
            quality: num(s, "quality", 50),
            // Lossy alpha leaves faint non-zero alpha in transparent areas; keep alpha at higher quality.
            qualityAlpha: Math.min(100, num(s, "quality", 50) + num(s, "alphaBoost", 0)),
            speed: num(s, "speed", 6),
            subsample: s.chroma === "444" ? 3 : 1,
            lossless: bool(s, "lossless"),
          });
          break;
        case "png": {
          const ox = await loaders.oxipng();
          out = await ox.default(toImageData(img), { level: num(s, "level", 2), interlace: false, optimiseAlpha: bool(s, "optimiseAlpha") });
          break;
        }
      }
      return new Uint8Array(out);
    },
    async optimisePng(bytes: Uint8Array, s: EncodeSettings) {
      const ox = await loaders.oxipng();
      return new Uint8Array(await ox.default(ab(bytes), { level: num(s, "level", 2), interlace: false, optimiseAlpha: bool(s, "optimiseAlpha") }));
    },
    async resize(img: RawImage, width: number, height: number) {
      const r = await (await loaders.resize()).default(toImageData(img), {
        width,
        height,
        method: "lanczos3",
        fitMethod: "stretch",
        premultiply: true,
        linearRGB: true,
      });
      return raw(r);
    },
    codecName(format: OutputFormat, s: EncodeSettings) {
      if (format === "jpeg") return "mozjpeg";
      if (format === "png") return "oxipng";
      if (format === "webp") return bool(s, "lossless") ? "libwebp-lossless" : "libwebp";
      return bool(s, "lossless") ? "libavif-lossless" : "libavif";
    },
  };
}
