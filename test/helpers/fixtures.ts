import sharp from "sharp";
import type { RawImage } from "../../src/pixels.js";

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth shapes + fine noise: behaves like a photograph for codecs and the classifier. */
export function photoLike(width: number, height: number, seed = 1, noise = 2): RawImage {
  const r = rng(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  const blobs = Array.from({ length: 6 }, () => ({ x: r() * width, y: r() * height, s: (0.2 + r() * 0.4) * Math.max(width, height), c: [r() * 255, r() * 255, r() * 255] }));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let R = 90 + 60 * Math.sin(x / 37) * Math.cos(y / 53), G = 110 + 50 * Math.sin((x + y) / 71), B = 120 + 40 * Math.cos(x / 23 - y / 41);
      for (const b of blobs) {
        const d = Math.exp(-((x - b.x) ** 2 + (y - b.y) ** 2) / (b.s * b.s));
        R += (b.c[0] - R) * d; G += (b.c[1] - G) * d; B += (b.c[2] - B) * d;
      }
      const n = (r() - 0.5) * noise;
      const o = (y * width + x) * 4;
      data[o] = R + n; data[o + 1] = G + n; data[o + 2] = B + n; data[o + 3] = 255;
    }
  }
  return { data, width, height };
}

/** Flat panels, 1px borders and "text" glyph rows: screenshot-like. */
export function screenshotLike(width: number, height: number, seed = 2): RawImage {
  const r = rng(seed);
  const data = new Uint8ClampedArray(width * height * 4);
  const set = (x: number, y: number, c: number[]) => {
    const o = (y * width + x) * 4;
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) set(x, y, [246, 247, 249]);
  const panels = [[0, 0, width, Math.min(40, height), [32, 41, 64]], [10, 50, width / 3, height - 60, [255, 255, 255]], [width / 3 + 20, 50, width - width / 3 - 30, height - 60, [255, 255, 255]]] as const;
  for (const [px, py, pw, ph, c] of panels) {
    for (let y = Math.floor(py); y < Math.min(height, py + ph); y++) for (let x = Math.floor(px); x < Math.min(width, px + pw); x++) set(x, y, c as unknown as number[]);
  }
  // glyph rows
  for (let line = 70; line < height - 20; line += 14) {
    let x = Math.floor(width / 3 + 30);
    while (x < width - 40) {
      const wlen = 3 + Math.floor(r() * 7);
      for (let k = 0; k < wlen && x < width - 40; k++, x += 6) {
        for (let gy = 0; gy < 8; gy++) for (let gx = 0; gx < 4; gx++) if (r() < 0.45) set(x + gx, line + gy, [30, 30, 30]);
      }
      x += 6;
    }
  }
  return { data, width, height };
}

/** Anti-aliased discs with transparent background. */
export function transparentIllustration(width: number, height: number): RawImage {
  const data = new Uint8ClampedArray(width * height * 4);
  const discs = [[width * 0.35, height * 0.4, Math.min(width, height) * 0.3, [220, 60, 60]], [width * 0.65, height * 0.6, Math.min(width, height) * 0.25, [40, 120, 220]]] as const;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      for (const [cx, cy, rad, c] of discs) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const a = Math.max(0, Math.min(1, rad - d + 0.5));
        if (a > 0) {
          data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = Math.round(Math.max(data[o + 3], a * 255));
        }
      }
    }
  }
  return { data, width, height };
}

export function gradient(width: number, height: number): RawImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = (x / width) * 255; data[o + 1] = (y / height) * 200 + 20; data[o + 2] = 255 - (x / width) * 180; data[o + 3] = 255;
    }
  }
  return { data, width, height };
}

const raw = (img: RawImage) => sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), { raw: { width: img.width, height: img.height, channels: 4 } });

export async function toPng(img: RawImage, opts: { exif?: Record<string, Record<string, string>>; icc?: string } = {}): Promise<Uint8Array> {
  let s = raw(img).png({ compressionLevel: 6 });
  if (opts.exif || opts.icc) s = s.withMetadata({ icc: opts.icc, exif: opts.exif });
  return new Uint8Array(await s.toBuffer());
}

export async function toJpeg(img: RawImage, opts: { quality?: number; orientation?: number; exif?: Record<string, Record<string, string>>; icc?: string } = {}): Promise<Uint8Array> {
  let s = raw(img).removeAlpha().jpeg({ quality: opts.quality ?? 92, mozjpeg: false });
  if (opts.exif || opts.icc || opts.orientation) s = s.withMetadata({ orientation: opts.orientation, icc: opts.icc, exif: opts.exif });
  return new Uint8Array(await s.toBuffer());
}

export async function toWebp(img: RawImage, opts: { lossless?: boolean; quality?: number } = {}): Promise<Uint8Array> {
  return new Uint8Array(await raw(img).webp({ lossless: opts.lossless, quality: opts.quality ?? 90 }).toBuffer());
}

export async function toGif(img: RawImage): Promise<Uint8Array> {
  return new Uint8Array(await raw(img).gif().toBuffer());
}

/** Two-frame animated GIF/WebP built by sharp from a vertically stacked strip. */
export async function animated(format: "gif" | "webp", width: number, height: number): Promise<Uint8Array> {
  const a = screenshotLike(width, height, 3);
  const b = photoLike(width, height, 4);
  const strip = new Uint8ClampedArray(width * height * 8);
  strip.set(a.data, 0);
  strip.set(b.data, a.data.length);
  const s = sharp(Buffer.from(strip.buffer), { raw: { width, height: height * 2, channels: 4, pageHeight: height } as never });
  return new Uint8Array(await (format === "gif" ? s.gif({ loop: 0 }) : s.webp({ loop: 0 })).toBuffer());
}

export async function decodeWithSharp(bytes: Uint8Array): Promise<RawImage> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}
