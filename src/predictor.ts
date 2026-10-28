import type { ImageFeatures } from "./classify.js";
import { PREDICTOR_MODEL } from "./predictor-model.js";
import type { ImageCategory, OutputFormat } from "./types.js";

/**
 * Where the per-codec quality search starts.
 * - `fixed`: one start per mode (original behaviour);
 * - `category`: median quality needed per codec, separately for photos and graphics (fitted on bench/predictor);
 * - `model`: ridge regression on cheap image features (same fit).
 * The search always verifies its result, so a bad start costs encodes, never quality.
 */
export type SearchStart = "fixed" | "category" | "model";

const GRAPHIC = new Set<ImageCategory>(["screenshot", "text-graphic", "illustration", "transparent-illustration"]);

const FEATURE_FNS: ((f: ImageFeatures) => number)[] = [
  (f) => Math.log(f.hfEnergy + 1e-4),
  (f) => Math.log(f.meanGrad + 1e-4),
  (f) => f.lumaStd,
  (f) => f.chromaRms,
  (f) => f.flatShare,
  (f) => f.smoothStepShare,
  (f) => f.hardEdgeShare,
  (f) => f.edgeShare16,
  (f) => Math.log(f.uniqueColors),
  (f) => f.transparentShare,
];

export interface PredictedStart {
  start: number;
  /** Step for the first probe after the start (≈ typical prediction error). */
  step: number;
}

export function predictStart(format: Exclude<OutputFormat, "png">, category: ImageCategory, features: ImageFeatures, how: Exclude<SearchStart, "fixed">): PredictedStart | undefined {
  const m = PREDICTOR_MODEL[`${format}:${GRAPHIC.has(category) ? "graphic" : "photo"}`];
  if (!m) return undefined;
  if (how === "category") return { start: m.median, step: Math.max(3, Math.round(m.sigma)) };
  const q = m.c + m.w.reduce((s, w, i) => s + w * FEATURE_FNS[i](features), 0);
  // Start half a typical error above the prediction: a first encode that passes is cheaper to refine downwards.
  return { start: Math.round(q + m.sigma / 2), step: Math.max(3, Math.round(m.sigma)) };
}
