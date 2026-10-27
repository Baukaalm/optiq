import { ascii, asciiBytes, concat, le24, le32, startsWith, u24le, u32le } from "./bytes.js";

export interface RiffChunk {
  fourcc: string;
  start: number;
  /** Exclusive end including padding. */
  end: number;
  data: Uint8Array;
}

export function isWebp(b: Uint8Array): boolean {
  return startsWith(b, "RIFF") && startsWith(b, "WEBP", 8);
}

export function parseWebpChunks(b: Uint8Array): RiffChunk[] {
  if (!isWebp(b)) throw new Error("Not a WebP");
  const riffEnd = Math.min(b.length, 8 + u32le(b, 4));
  const chunks: RiffChunk[] = [];
  let o = 12;
  while (o + 8 <= riffEnd) {
    const fourcc = ascii(b, o, 4);
    const size = u32le(b, o + 4);
    if (o + 8 + size > b.length) throw new Error("Truncated WebP chunk");
    const end = Math.min(o + 8 + size + (size & 1), b.length);
    chunks.push({ fourcc, start: o, end, data: b.subarray(o + 8, o + 8 + size) });
    o = end;
  }
  if (!chunks.length) throw new Error("Empty WebP");
  return chunks;
}

export interface WebpInfo {
  width: number;
  height: number;
  hasAlpha: boolean;
  animated: boolean;
  lossless: boolean;
  exif?: Uint8Array;
  xmp?: Uint8Array;
  icc?: Uint8Array;
}

function vp8Dims(d: Uint8Array): { width: number; height: number } {
  if (d.length < 10 || d[3] !== 0x9d || d[4] !== 0x01 || d[5] !== 0x2a) throw new Error("Invalid VP8 frame header");
  return { width: (d[6] | (d[7] << 8)) & 0x3fff, height: (d[8] | (d[9] << 8)) & 0x3fff };
}

function vp8lDims(d: Uint8Array): { width: number; height: number; alpha: boolean } {
  if (d.length < 5 || d[0] !== 0x2f) throw new Error("Invalid VP8L header");
  const bits = u32le(d, 1);
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, alpha: ((bits >>> 28) & 1) === 1 };
}

export function probeWebp(b: Uint8Array): WebpInfo {
  const chunks = parseWebpChunks(b);
  const first = chunks[0];
  const find = (cc: string) => chunks.find((c) => c.fourcc === cc)?.data;
  if (first.fourcc === "VP8X") {
    const d = first.data;
    if (d.length < 10) throw new Error("Invalid VP8X chunk");
    const flags = d[0];
    const animated = (flags & 0x02) !== 0;
    const bitstream = find("VP8L") ?? find("VP8 ");
    if (!animated && !bitstream) throw new Error("WebP has no image data");
    return {
      width: u24le(d, 4) + 1,
      height: u24le(d, 7) + 1,
      hasAlpha: (flags & 0x10) !== 0,
      animated,
      lossless: !!find("VP8L"),
      exif: find("EXIF"),
      xmp: find("XMP "),
      icc: find("ICCP"),
    };
  }
  if (first.fourcc === "VP8 ") return { ...vp8Dims(first.data), hasAlpha: false, animated: false, lossless: false };
  if (first.fourcc === "VP8L") {
    const { width, height, alpha } = vp8lDims(first.data);
    return { width, height, hasAlpha: alpha, animated: false, lossless: true };
  }
  throw new Error(`Unexpected WebP chunk ${first.fourcc}`);
}

function chunk(fourcc: string, data: Uint8Array): Uint8Array {
  const parts = [asciiBytes(fourcc), le32(data.length), data];
  if (data.length & 1) parts.push(new Uint8Array(1));
  return concat(parts);
}

function riff(chunks: Uint8Array[]): Uint8Array {
  const body = concat(chunks);
  return concat([asciiBytes("RIFF"), le32(body.length + 4), asciiBytes("WEBP"), body]);
}

export interface WebpMetadata {
  exif?: Uint8Array;
  xmp?: Uint8Array;
  icc?: Uint8Array;
}

/**
 * Rebuild a WebP with the given metadata, keeping image chunks (VP8/VP8L/ALPH/ANIM/ANMF) byte-identical.
 * `keepIcc` keeps the original ICCP chunk when `meta.icc` is not provided.
 */
export function rewriteWebpMetadata(b: Uint8Array, meta: WebpMetadata, keepIcc: boolean): Uint8Array {
  const info = probeWebp(b);
  const chunks = parseWebpChunks(b);
  const icc = meta.icc ?? (keepIcc ? info.icc : undefined);
  const imageChunks = chunks.filter((c) => !["VP8X", "ICCP", "EXIF", "XMP "].includes(c.fourcc));
  // The simple format suffices for a lone VP8/VP8L chunk (alpha in lossy VP8 needs ALPH + VP8X).
  const lone = imageChunks.length === 1 ? imageChunks[0] : undefined;
  if (!icc && !meta.exif && !meta.xmp && !info.animated && lone && (lone.fourcc === "VP8L" || lone.fourcc === "VP8 ")) {
    return riff([b.subarray(lone.start, lone.end)]);
  }
  let flags = 0;
  if (icc) flags |= 0x20;
  if (info.hasAlpha || chunks.some((c) => c.fourcc === "ALPH")) flags |= 0x10;
  if (meta.exif) flags |= 0x08;
  if (meta.xmp) flags |= 0x04;
  if (info.animated) flags |= 0x02;
  const vp8x = concat([new Uint8Array([flags, 0, 0, 0]), le24(info.width - 1), le24(info.height - 1)]);
  // Chunk order per spec: VP8X, ICCP, ANIM/ANMF or ALPH+bitstream, EXIF, XMP.
  const out: Uint8Array[] = [chunk("VP8X", vp8x)];
  if (icc) out.push(chunk("ICCP", icc));
  for (const c of imageChunks) out.push(b.subarray(c.start, c.end));
  if (meta.exif) out.push(chunk("EXIF", meta.exif));
  if (meta.xmp) out.push(chunk("XMP ", meta.xmp));
  return riff(out);
}

export function injectWebpMetadata(encoded: Uint8Array, meta: WebpMetadata): Uint8Array {
  if (!meta.exif && !meta.xmp && !meta.icc) return encoded;
  return rewriteWebpMetadata(encoded, meta, false);
}

/** First frame of an animated WebP as a standalone still WebP, plus its placement on the canvas. */
export function extractFirstWebpFrame(b: Uint8Array): { still: Uint8Array; x: number; y: number; canvasWidth: number; canvasHeight: number } {
  const info = probeWebp(b);
  const anmf = parseWebpChunks(b).find((c) => c.fourcc === "ANMF");
  if (!anmf || anmf.data.length < 16) throw new Error("Animated WebP has no frames");
  const d = anmf.data;
  const x = u24le(d, 0) * 2;
  const y = u24le(d, 3) * 2;
  const w = u24le(d, 6) + 1;
  const h = u24le(d, 9) + 1;
  const inner: RiffChunk[] = [];
  let o = 16;
  while (o + 8 <= d.length) {
    const size = u32le(d, o + 4);
    const end = Math.min(o + 8 + size + (size & 1), d.length);
    inner.push({ fourcc: ascii(d, o, 4), start: o, end, data: d.subarray(o + 8, o + 8 + size) });
    o = end;
  }
  const alph = inner.find((c) => c.fourcc === "ALPH");
  const bits = inner.find((c) => c.fourcc === "VP8 " || c.fourcc === "VP8L");
  if (!bits) throw new Error("Animated WebP frame has no bitstream");
  const parts = [d.subarray(bits.start, bits.end)];
  if (alph) {
    const vp8x = concat([new Uint8Array([0x10, 0, 0, 0]), le24(w - 1), le24(h - 1)]);
    parts.unshift(chunk("VP8X", vp8x), d.subarray(alph.start, alph.end));
  }
  return { still: riff(parts), x, y, canvasWidth: info.width, canvasHeight: info.height };
}
