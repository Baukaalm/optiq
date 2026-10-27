import type { RawImage } from "./pixels.js";
import type { ImageCategory } from "./types.js";

export interface ImageFeatures {
  sampledPixels: number;
  /** Distinct RGBA values among sampled pixels (capped at 4096). */
  uniqueColors: number;
  /** Share of sampled pixels having the single most common colour (background). */
  dominantColorShare: number;
  /** Horizontally/vertically adjacent pairs with identical RGBA. */
  flatShare: number;
  /** Adjacent pairs with luma step > 64 (hard edges: text, UI lines). */
  hardEdgeShare: number;
  /** Adjacent non-identical pairs with luma step <= 3 (smooth ramps). */
  smoothStepShare: number;
  /** Pixels with alpha < 255. */
  transparentShare: number;
}

const PATCH = 16;
const MAX_PATCHES_PER_AXIS = 24;
const UNIQUE_CAP = 4096;

/**
 * Deterministic feature extraction on a grid of up to 24x24 patches of 16x16 contiguous pixels.
 * Adjacency is only evaluated inside patches, so it reflects the full-resolution content without scanning every pixel.
 */
export function extractFeatures(img: RawImage): ImageFeatures {
  const { width: W, height: H, data } = img;
  const pw = Math.min(PATCH, W);
  const ph = Math.min(PATCH, H);
  const nx = Math.min(MAX_PATCHES_PER_AXIS, Math.max(1, Math.floor(W / pw)));
  const ny = Math.min(MAX_PATCHES_PER_AXIS, Math.max(1, Math.floor(H / ph)));
  const counts = new Map<number, number>();
  let sampled = 0, pairs = 0, flat = 0, hard = 0, smooth = 0, transparent = 0;
  const luma = (o: number) => (data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 8;
  const word = (o: number) => ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0;
  const pair = (a: number, b: number) => {
    pairs++;
    if (word(a) === word(b)) {
      flat++;
      return;
    }
    const d = Math.abs(luma(a) - luma(b));
    if (d > 64) hard++;
    else if (d <= 3) smooth++;
  };
  for (let j = 0; j < ny; j++) {
    const y0 = Math.floor(((H - ph) * (j + 0.5)) / ny);
    for (let i = 0; i < nx; i++) {
      const x0 = Math.floor(((W - pw) * (i + 0.5)) / nx);
      for (let y = y0; y < y0 + ph; y++) {
        for (let x = x0; x < x0 + pw; x++) {
          const o = (y * W + x) * 4;
          sampled++;
          if (data[o + 3] !== 255) transparent++;
          const w = word(o);
          if (counts.size < UNIQUE_CAP || counts.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
          if (x + 1 < x0 + pw) pair(o, o + 4);
          if (y + 1 < y0 + ph) pair(o, o + W * 4);
        }
      }
    }
  }
  let dominant = 0;
  for (const c of counts.values()) if (c > dominant) dominant = c;
  return {
    sampledPixels: sampled,
    uniqueColors: counts.size,
    dominantColorShare: dominant / sampled,
    flatShare: pairs ? flat / pairs : 1,
    hardEdgeShare: pairs ? hard / pairs : 0,
    smoothStepShare: pairs ? smooth / pairs : 0,
    transparentShare: transparent / sampled,
  };
}

/**
 * Heuristic rules with hand-set thresholds, checked against the test fixtures and the benchmark corpus (see docs/architecture.md);
 * the category only steers which codecs/settings are tried first, never the quality decision.
 */
export function classifyFeatures(f: ImageFeatures): ImageCategory {
  if (f.transparentShare > 0.01 && (f.flatShare > 0.5 || f.uniqueColors < 1024)) return "transparent-illustration";
  if (f.hardEdgeShare < 0.003 && f.flatShare + f.smoothStepShare > 0.95 && f.uniqueColors > 64) return "gradient";
  if (f.flatShare >= 0.45) {
    if (f.hardEdgeShare >= 0.06 && f.dominantColorShare >= 0.35) return "text-graphic";
    if (f.uniqueColors < 256 && f.hardEdgeShare < 0.02) return "illustration";
    return "screenshot";
  }
  return "photo";
}

export function classify(img: RawImage): { category: ImageCategory; features: ImageFeatures } {
  const features = extractFeatures(img);
  return { category: classifyFeatures(features), features };
}
