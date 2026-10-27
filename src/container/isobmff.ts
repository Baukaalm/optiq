import { ascii, u32be } from "./bytes.js";

export interface HeifInfo {
  brand: "avif" | "heif";
  animated: boolean;
  width?: number;
  height?: number;
  bitDepth?: number;
  hasAlpha: boolean;
  /** irot/imir present: the decoder output must be transformed for display. */
  hasTransform: boolean;
  icc?: Uint8Array;
  /** CICP colour signalling from an nclx colr box (1/13 = BT.709 primaries / sRGB transfer). */
  nclx?: { primaries: number; transfer: number; matrix: number; fullRange: boolean };
  hasExifItem: boolean;
  hasXmpItem: boolean;
}

interface Box {
  type: string;
  start: number;
  dataStart: number;
  end: number;
}

function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  let o = start;
  while (o + 8 <= end) {
    let size = u32be(b, o);
    const type = ascii(b, o + 4, 4);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) return;
      const hi = u32be(b, o + 8);
      if (hi !== 0) return; // >4 GiB boxes are not plausible for an upload
      size = u32be(b, o + 12);
      header = 16;
    } else if (size === 0) size = end - o;
    if (size < header || o + size > end) return;
    yield { type, start: o, dataStart: o + header, end: o + size };
    o += size;
  }
}

const AVIF_BRANDS = new Set(["avif", "avis"]);
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "mif2"]);

/** Returns the brand family declared by `ftyp`, or undefined if this is not an image ISOBMFF file. */
export function sniffIsobmff(b: Uint8Array): "avif" | "heif" | undefined {
  if (b.length < 16 || ascii(b, 4, 4) !== "ftyp") return undefined;
  const size = Math.min(u32be(b, 0), b.length);
  const brands = [ascii(b, 8, 4)];
  for (let o = 16; o + 4 <= size; o += 4) brands.push(ascii(b, o, 4));
  if (brands.some((x) => AVIF_BRANDS.has(x))) return "avif";
  if (brands.some((x) => HEIF_BRANDS.has(x))) return "heif";
  return undefined;
}

export function probeIsobmff(b: Uint8Array): HeifInfo {
  const brand = sniffIsobmff(b);
  if (!brand) throw new Error("Not an AVIF/HEIF file");
  const ftypSize = u32be(b, 0);
  const brands: string[] = [ascii(b, 8, 4)];
  for (let o = 16; o + 4 <= ftypSize; o += 4) brands.push(ascii(b, o, 4));
  const info: HeifInfo = {
    brand,
    animated: brands[0] === "avis" || brands[0] === "msf1" || brands[0] === "hevs",
    hasAlpha: false,
    hasTransform: false,
    hasExifItem: false,
    hasXmpItem: false,
  };
  let maxArea = 0;
  for (const top of boxes(b, 0, b.length)) {
    if (top.type !== "meta") continue;
    // meta is a FullBox: 4 bytes version/flags
    for (const child of boxes(b, top.dataStart + 4, top.end)) {
      if (child.type === "iinf") {
        const version = b[child.dataStart];
        const entriesStart = child.dataStart + 4 + (version === 0 ? 2 : 4);
        for (const infe of boxes(b, entriesStart, child.end)) {
          if (infe.type !== "infe") continue;
          const v = b[infe.dataStart];
          if (v < 2) continue;
          const typeOff = infe.dataStart + 4 + (v === 2 ? 2 : 4) + 2;
          const itemType = ascii(b, typeOff, 4);
          if (itemType === "Exif") info.hasExifItem = true;
          if (itemType === "mime") info.hasXmpItem = true;
        }
      }
      if (child.type !== "iprp") continue;
      for (const ipco of boxes(b, child.dataStart, child.end)) {
        if (ipco.type !== "ipco") continue;
        for (const p of boxes(b, ipco.dataStart, ipco.end)) {
          if (p.type === "ispe" && p.end - p.dataStart >= 12) {
            const w = u32be(b, p.dataStart + 4);
            const h = u32be(b, p.dataStart + 8);
            // Take the largest declared extent: conservative for decompression-bomb checks.
            if (w * h > maxArea) {
              maxArea = w * h;
              info.width = w;
              info.height = h;
            }
          } else if (p.type === "pixi" && p.end - p.dataStart >= 6) {
            info.bitDepth = Math.max(info.bitDepth ?? 0, b[p.dataStart + 5]);
          } else if (p.type === "auxC") {
            if (ascii(b, p.dataStart + 4, p.end - p.dataStart - 4).includes("alpha")) info.hasAlpha = true;
          } else if (p.type === "irot" || p.type === "imir") {
            info.hasTransform = true;
          } else if (p.type === "colr" && p.end - p.dataStart >= 4) {
            const ct = ascii(b, p.dataStart, 4);
            if (ct === "prof" || ct === "rICC") info.icc = b.subarray(p.dataStart + 4, p.end);
            else if (ct === "nclx" && p.end - p.dataStart >= 11) {
              const d = p.dataStart + 4;
              info.nclx = { primaries: (b[d] << 8) | b[d + 1], transfer: (b[d + 2] << 8) | b[d + 3], matrix: (b[d + 4] << 8) | b[d + 5], fullRange: (b[d + 6] & 0x80) !== 0 };
            }
          }
        }
      }
    }
  }
  return info;
}

/**
 * Rewrite unspecified (2) colour primaries / transfer characteristics in nclx colr boxes to BT.709 / sRGB (1 / 13),
 * in place. Box sizes do not change, so item offsets stay valid. The matrix and range are left as encoded.
 */
export function tagAvifSrgb(b: Uint8Array): Uint8Array {
  const out = b.slice();
  for (const top of boxes(out, 0, out.length)) {
    if (top.type !== "meta") continue;
    for (const child of boxes(out, top.dataStart + 4, top.end)) {
      if (child.type !== "iprp") continue;
      for (const ipco of boxes(out, child.dataStart, child.end)) {
        if (ipco.type !== "ipco") continue;
        for (const p of boxes(out, ipco.dataStart, ipco.end)) {
          if (p.type !== "colr" || p.end - p.dataStart < 11 || ascii(out, p.dataStart, 4) !== "nclx") continue;
          const d = p.dataStart + 4;
          if (out[d] === 0 && out[d + 1] === 2) out[d + 1] = 1;
          if (out[d + 2] === 0 && out[d + 3] === 2) out[d + 3] = 13;
        }
      }
    }
  }
  return out;
}
