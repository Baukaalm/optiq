/** 8-bit RGBA, non-premultiplied, row-major. Structurally compatible with `ImageData`. */
export interface RawImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Rotate/flip pixels so that EXIF orientation 1 displays them correctly. */
export function applyOrientation(img: RawImage, orientation: number): RawImage {
  if (orientation <= 1 || orientation > 8) return img;
  const { width: w, height: h } = img;
  const swap = orientation >= 5;
  const dw = swap ? h : w;
  const dh = swap ? w : h;
  const src = new Uint32Array(img.data.buffer, img.data.byteOffset, w * h);
  const out = new Uint8ClampedArray(dw * dh * 4);
  const dst = new Uint32Array(out.buffer);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let sx: number, sy: number;
      switch (orientation) {
        case 2: sx = w - 1 - x; sy = y; break;
        case 3: sx = w - 1 - x; sy = h - 1 - y; break;
        case 4: sx = x; sy = h - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = h - 1 - x; break;
        case 7: sx = w - 1 - y; sy = h - 1 - x; break;
        default: sx = w - 1 - y; sy = x; break; // 8
      }
      dst[y * dw + x] = src[sy * w + sx];
    }
  }
  return { data: out, width: dw, height: dh };
}

export function hasTransparentPixels(img: RawImage): boolean {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  return false;
}

export function pixelsEqual(a: RawImage, b: RawImage): boolean {
  if (a.width !== b.width || a.height !== b.height || a.data.length !== b.data.length) return false;
  const n = a.width * a.height;
  // Compare as 32-bit words when aligned; fall back to bytes otherwise.
  if (a.data.byteOffset % 4 === 0 && b.data.byteOffset % 4 === 0) {
    const x = new Uint32Array(a.data.buffer, a.data.byteOffset, n);
    const y = new Uint32Array(b.data.buffer, b.data.byteOffset, n);
    for (let i = 0; i < n; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

/**
 * Exact equality where fully transparent pixels compare equal regardless of their RGB values.
 * Used only when the caller allows `optimiseAlpha`-style changes (never in lossless mode).
 */
export function visiblePixelsEqual(a: RawImage, b: RawImage): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  const x = a.data;
  const y = b.data;
  for (let i = 0; i < x.length; i += 4) {
    if (x[i + 3] !== y[i + 3]) return false;
    if (x[i + 3] === 0) continue;
    if (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2]) return false;
  }
  return true;
}

export function targetSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width, height };
  const s = maxSide / longest;
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

/**
 * Deterministic `grid` x `grid` mosaic of full-resolution tiles taken evenly across the image (tile origins aligned
 * to 16 px, so codec block grids line up). Used as a cheap proxy for quality search on large images: unlike a
 * downscaled copy, tiles keep the original per-pixel detail, so codec behaviour per block is comparable.
 */
export function tileMosaic(img: RawImage, tile = 512, grid = 3): RawImage {
  const tw = Math.min(tile, Math.floor(img.width / grid / 16) * 16);
  const th = Math.min(tile, Math.floor(img.height / grid / 16) * 16);
  if (tw < 16 || th < 16) return img;
  const out = new Uint8ClampedArray(tw * grid * th * grid * 4);
  const W = tw * grid;
  for (let gy = 0; gy < grid; gy++) {
    const sy = Math.floor(((img.height - th) * (gy + 0.5)) / grid / 16) * 16;
    for (let gx = 0; gx < grid; gx++) {
      const sx = Math.floor(((img.width - tw) * (gx + 0.5)) / grid / 16) * 16;
      for (let y = 0; y < th; y++) {
        const src = ((sy + y) * img.width + sx) * 4;
        out.set(img.data.subarray(src, src + tw * 4), ((gy * th + y) * W + gx * tw) * 4);
      }
    }
  }
  return { data: out, width: W, height: th * grid };
}
