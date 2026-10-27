import { ascii, asciiBytes, be32, concat, crc32, startsWith, u32be, zlibDeflate, zlibInflate } from "./bytes.js";

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface PngChunk {
  type: string;
  start: number;
  end: number;
  data: Uint8Array;
}

export function parsePngChunks(b: Uint8Array): PngChunk[] {
  if (!startsWith(b, PNG_SIGNATURE)) throw new Error("Not a PNG");
  const chunks: PngChunk[] = [];
  let o = 8;
  while (o + 12 <= b.length) {
    const len = u32be(b, o);
    const type = ascii(b, o + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error("Invalid PNG chunk type");
    const end = o + 12 + len;
    if (end > b.length) throw new Error("Truncated PNG chunk");
    chunks.push({ type, start: o, end, data: b.subarray(o + 8, o + 8 + len) });
    o = end;
    if (type === "IEND") return chunks;
  }
  throw new Error("Truncated PNG: missing IEND");
}

export interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlaced: boolean;
  hasAlpha: boolean;
  animated: boolean;
  frameCount: number;
  exif?: Uint8Array;
  xmp?: Uint8Array;
  /** zlib-compressed ICC (as stored in iCCP); inflate with `inflateIcc`. */
  iccCompressed?: Uint8Array;
  /** Colour chunks other than iCCP that affect rendering. */
  hasGamaOrChrm: boolean;
  hasSrgbChunk: boolean;
}

export function probePng(b: Uint8Array): PngInfo {
  const chunks = parsePngChunks(b);
  const ihdr = chunks[0];
  if (!ihdr || ihdr.type !== "IHDR" || ihdr.data.length !== 13) throw new Error("PNG has no valid IHDR");
  const d = ihdr.data;
  const colorType = d[9];
  const info: PngInfo = {
    width: u32be(d, 0),
    height: u32be(d, 4),
    bitDepth: d[8],
    colorType,
    interlaced: d[12] === 1,
    hasAlpha: colorType === 4 || colorType === 6,
    animated: false,
    frameCount: 1,
    hasGamaOrChrm: false,
    hasSrgbChunk: false,
  };
  if (!chunks.some((c) => c.type === "IDAT")) throw new Error("PNG has no IDAT");
  for (const c of chunks) {
    switch (c.type) {
      case "tRNS":
        info.hasAlpha = true;
        break;
      case "acTL": {
        const frames = c.data.length >= 4 ? u32be(c.data, 0) : 1;
        info.frameCount = frames;
        info.animated = frames > 1;
        break;
      }
      case "eXIf":
        info.exif = c.data;
        break;
      case "iCCP": {
        const nul = c.data.indexOf(0);
        if (nul > 0 && nul + 2 <= c.data.length) info.iccCompressed = c.data.subarray(nul + 2);
        break;
      }
      case "iTXt":
        if (startsWith(c.data, "XML:com.adobe.xmp\0")) {
          // keyword\0 compressionFlag compressionMethod language\0 translated\0 text
          const p = 18;
          if (c.data[p] === 0) {
            let q = p + 2;
            q = c.data.indexOf(0, q) + 1;
            q = q > 0 ? c.data.indexOf(0, q) + 1 : 0;
            if (q > 0) info.xmp = c.data.subarray(q);
          }
        }
        break;
      case "gAMA":
      case "cHRM":
        info.hasGamaOrChrm = true;
        break;
      case "sRGB":
        info.hasSrgbChunk = true;
        break;
    }
  }
  return info;
}

export function inflateIcc(compressed: Uint8Array): Promise<Uint8Array> {
  return zlibInflate(compressed, 16 * 1024 * 1024);
}

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const t = asciiBytes(type);
  return concat([be32(data.length), t, data, be32(crc32([t, data]))]);
}

/** Chunks needed to render the image exactly (pixels, palette, transparency, colour interpretation, animation). */
const RENDERING_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "cICP", "mDCV", "cLLI", "acTL", "fcTL", "fdAT", "pHYs"]);

export interface PngMetadata {
  exif?: Uint8Array;
  xmp?: Uint8Array;
  /** Raw (uncompressed) ICC profile to embed as iCCP. */
  icc?: Uint8Array;
}

async function metadataChunks(meta: PngMetadata): Promise<{ before: Uint8Array[]; after: Uint8Array[] }> {
  const before: Uint8Array[] = [];
  const after: Uint8Array[] = [];
  if (meta.icc) before.push(pngChunk("iCCP", concat([asciiBytes("ICC profile\0\0"), await zlibDeflate(meta.icc)])));
  if (meta.exif) before.push(pngChunk("eXIf", meta.exif));
  if (meta.xmp) after.push(pngChunk("iTXt", concat([asciiBytes("XML:com.adobe.xmp\0\0\0\0\0"), meta.xmp])));
  return { before, after };
}

/**
 * Rewrite a PNG keeping only rendering chunks, then add `meta`. `dropColorChunks` removes iCCP/sRGB/gAMA/cHRM
 * (used when the caller supplies its own ICC or the profile is sRGB and metadata stripping was requested).
 */
export async function rewritePngMetadata(b: Uint8Array, meta: PngMetadata, opts: { dropIcc: boolean }): Promise<Uint8Array> {
  const chunks = parsePngChunks(b);
  const extra = await metadataChunks(meta);
  const parts: Uint8Array[] = [Uint8Array.from(PNG_SIGNATURE)];
  let insertedBefore = false;
  for (const c of chunks) {
    if (!RENDERING_CHUNKS.has(c.type)) continue;
    if (c.type === "iCCP" && (opts.dropIcc || meta.icc)) continue;
    if (c.type === "sRGB" && meta.icc) continue; // iCCP and sRGB must not both be present
    if (!insertedBefore && (c.type === "PLTE" || c.type === "IDAT" || c.type === "acTL")) {
      parts.push(...extra.before);
      insertedBefore = true;
    }
    if (c.type === "IEND") parts.push(...extra.after);
    parts.push(b.subarray(c.start, c.end));
  }
  return concat(parts);
}

/** Insert metadata into a freshly encoded PNG. */
export async function injectPngMetadata(encoded: Uint8Array, meta: PngMetadata): Promise<Uint8Array> {
  if (!meta.exif && !meta.xmp && !meta.icc) return encoded;
  return rewritePngMetadata(encoded, meta, { dropIcc: true });
}
