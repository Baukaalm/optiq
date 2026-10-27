import { startsWith, u16le } from "./bytes.js";

export interface GifInfo {
  width: number;
  height: number;
  frameCount: number;
  animated: boolean;
  hasTransparency: boolean;
}

interface GifFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  interlaced: boolean;
  palette: Uint8Array;
  transparentIndex: number;
  minCodeSize: number;
  /** Concatenated LZW sub-block data. */
  dataBlocks: Uint8Array[];
}

function skipSubBlocks(b: Uint8Array, o: number, collect?: Uint8Array[]): number {
  for (;;) {
    if (o >= b.length) throw new Error("Truncated GIF");
    const n = b[o++];
    if (n === 0) return o;
    if (o + n > b.length) throw new Error("Truncated GIF sub-block");
    collect?.push(b.subarray(o, o + n));
    o += n;
  }
}

function walk(b: Uint8Array, stopAfterFirst: boolean): { info: GifInfo; first?: GifFrame } {
  if (!startsWith(b, "GIF87a") && !startsWith(b, "GIF89a")) throw new Error("Not a GIF");
  if (b.length < 13) throw new Error("Truncated GIF");
  const width = u16le(b, 6);
  const height = u16le(b, 8);
  const flags = b[10];
  let o = 13;
  let globalPalette: Uint8Array = new Uint8Array(0);
  if (flags & 0x80) {
    const size = 3 * (1 << ((flags & 7) + 1));
    globalPalette = b.subarray(o, o + size);
    o += size;
  }
  let frameCount = 0;
  let hasTransparency = false;
  let transparentIndex = -1;
  let first: GifFrame | undefined;
  while (o < b.length) {
    const block = b[o++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = b[o++];
      if (label === 0xf9 && b[o] >= 4) {
        const packed = b[o + 1];
        transparentIndex = packed & 1 ? b[o + 4] : -1;
        if (packed & 1) hasTransparency = true;
      }
      o = skipSubBlocks(b, o);
      continue;
    }
    if (block !== 0x2c) throw new Error("Invalid GIF block");
    if (o + 9 > b.length) throw new Error("Truncated GIF image descriptor");
    const fl = b[o + 8];
    const frame: GifFrame = {
      left: u16le(b, o),
      top: u16le(b, o + 2),
      width: u16le(b, o + 4),
      height: u16le(b, o + 6),
      interlaced: (fl & 0x40) !== 0,
      palette: globalPalette,
      transparentIndex,
      minCodeSize: 0,
      dataBlocks: [],
    };
    o += 9;
    if (fl & 0x80) {
      const size = 3 * (1 << ((fl & 7) + 1));
      frame.palette = b.subarray(o, o + size);
      o += size;
    }
    frame.minCodeSize = b[o++];
    const collect = frameCount === 0 ? frame.dataBlocks : undefined;
    o = skipSubBlocks(b, o, collect);
    if (frameCount === 0) first = frame;
    frameCount++;
    transparentIndex = -1;
    if (stopAfterFirst) break;
  }
  if (frameCount === 0) throw new Error("GIF has no frames");
  return { info: { width, height, frameCount, animated: frameCount > 1, hasTransparency }, first };
}

export function probeGif(b: Uint8Array): GifInfo {
  return walk(b, false).info;
}

function lzwDecode(minCodeSize: number, blocks: Uint8Array[], pixelCount: number): Uint8Array {
  if (minCodeSize < 2 || minCodeSize > 8) throw new Error("Invalid GIF LZW code size");
  const out = new Uint8Array(pixelCount);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  for (let i = 0; i < clear; i++) {
    suffix[i] = i;
    prefix[i] = -1;
  }
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let prev = -1;
  let outPos = 0;
  let bits = 0;
  let nbits = 0;
  const stack = new Uint8Array(4096);
  outer: for (const blk of blocks) {
    for (let i = 0; i < blk.length; i++) {
      bits |= blk[i] << nbits;
      nbits += 8;
      while (nbits >= codeSize) {
        const code = bits & ((1 << codeSize) - 1);
        bits >>>= codeSize;
        nbits -= codeSize;
        if (code === clear) {
          codeSize = minCodeSize + 1;
          next = eoi + 1;
          prev = -1;
          continue;
        }
        if (code === eoi) break outer;
        let cur = code;
        let firstChar: number;
        if (code < next && (code < clear || code > eoi)) {
          // known code
        } else if (code === next && prev >= 0) {
          cur = prev;
        } else if (code >= next) {
          throw new Error("Invalid GIF LZW code");
        }
        // emit string for cur
        let sp = 0;
        let c = cur;
        while (c >= 0) {
          stack[sp++] = suffix[c];
          c = prefix[c];
          if (sp >= 4096) throw new Error("Invalid GIF LZW chain");
        }
        firstChar = stack[sp - 1];
        while (sp > 0 && outPos < pixelCount) out[outPos++] = stack[--sp];
        if (code === next && prev >= 0 && outPos < pixelCount) out[outPos++] = firstChar;
        if (prev >= 0 && next < 4096) {
          prefix[next] = prev;
          suffix[next] = firstChar;
          next++;
          if (next === 1 << codeSize && codeSize < 12) codeSize++;
        }
        prev = code;
        if (outPos >= pixelCount) break outer;
      }
    }
  }
  return out;
}

/** Decode the first frame composited on a transparent logical screen, as RGBA. */
export function decodeGifFirstFrame(b: Uint8Array): { data: Uint8ClampedArray; width: number; height: number } {
  const { info, first } = walk(b, true);
  if (!first) throw new Error("GIF has no frames");
  const { width, height } = info;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const indices = lzwDecode(first.minCodeSize, first.dataBlocks, first.width * first.height);
  const rows: number[] = [];
  if (first.interlaced) {
    for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < first.height; y += step) rows.push(y);
  } else for (let y = 0; y < first.height; y++) rows.push(y);
  for (let r = 0; r < rows.length; r++) {
    const y = first.top + rows[r];
    if (y >= height) continue;
    for (let x = 0; x < first.width; x++) {
      const px = first.left + x;
      if (px >= width) continue;
      const idx = indices[r * first.width + x];
      if (idx === first.transparentIndex || idx * 3 + 2 >= first.palette.length) continue;
      const o = (y * width + px) * 4;
      rgba[o] = first.palette[idx * 3];
      rgba[o + 1] = first.palette[idx * 3 + 1];
      rgba[o + 2] = first.palette[idx * 3 + 2];
      rgba[o + 3] = 255;
    }
  }
  return { data: rgba, width, height };
}
