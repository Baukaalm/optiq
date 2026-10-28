// Fit and validate the quality predictor on labels.jsonl (train split), evaluate on the held-out test split.
// 1) start-point error: current fixed start vs train median vs ridge regression on image features;
// 2) search simulation assuming pass(q) <=> q >= q* (the same monotonicity the engine relies on):
//    encodes needed and overshoot above q* for the current bisection and for prediction-centred galloping.
// Writes bench/predictor/model.json (coefficients) and prints a report. Usage: node bench/predictor/fit.mjs
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const rows = (await readFile(join(here, "labels.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
const RANGES = { jpeg: [40, 98], webp: [40, 99], avif: [25, 95] };
const TOL = 5; // balanced
const GRAPHIC = new Set(["screenshot", "text-graphic", "illustration", "transparent-illustration"]);

export const FEATURES = [
  ["logHf", (f) => Math.log(f.hfEnergy + 1e-4)],
  ["logGrad", (f) => Math.log(f.meanGrad + 1e-4)],
  ["lumaStd", (f) => f.lumaStd],
  ["chromaRms", (f) => f.chromaRms],
  ["flat", (f) => f.flatShare],
  ["smooth", (f) => f.smoothStepShare],
  ["hardEdge", (f) => f.hardEdgeShare],
  ["edge16", (f) => f.edgeShare16],
  ["logColors", (f) => Math.log(f.uniqueColors)],
  ["transparent", (f) => f.transparentShare],
];

function ridge(X, y, lambda) {
  const d = X[0].length;
  const mu = Array.from({ length: d }, (_, j) => X.reduce((s, r) => s + r[j], 0) / X.length);
  const sd = Array.from({ length: d }, (_, j) => Math.sqrt(X.reduce((s, r) => s + (r[j] - mu[j]) ** 2, 0) / X.length) || 1);
  const Z = X.map((r) => r.map((v, j) => (v - mu[j]) / sd[j]));
  const ym = y.reduce((a, b) => a + b, 0) / y.length;
  const A = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => Z.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? lambda : 0)));
  const b = Array.from({ length: d }, (_, i) => Z.reduce((s, r, k) => s + r[i] * (y[k] - ym), 0));
  // Gauss-Jordan
  for (let i = 0; i < d; i++) {
    let p = i;
    for (let k = i + 1; k < d; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k;
    [A[i], A[p]] = [A[p], A[i]];
    [b[i], b[p]] = [b[p], b[i]];
    for (let k = 0; k < d; k++) {
      if (k === i) continue;
      const f = A[k][i] / A[i][i];
      for (let j = i; j < d; j++) A[k][j] -= f * A[i][j];
      b[k] -= f * b[i];
    }
  }
  const w = b.map((v, i) => v / A[i][i]);
  // Back to raw feature space: q = c + sum(wr_j * x_j)
  const wr = w.map((v, j) => v / sd[j]);
  const c = ym - wr.reduce((s, v, j) => s + v * mu[j], 0);
  return { c, w: wr };
}
const predictRaw = (m, x) => m.c + m.w.reduce((s, v, j) => s + v * x[j], 0);
const fx = (r) => FEATURES.map(([, f]) => f(r.features));
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const mae = (a) => a.reduce((s, v) => s + Math.abs(v), 0) / a.length;

// ---- current engine search (copied from engine.ts, balanced, pass(q) = q >= qs) ----
function searchCurrent(qs, start, [lo0, hi0], budget = 4) {
  let lo = lo0, hi = hi0, passQ, q = start, n = 0, share = budget;
  while (share > 0 && lo <= hi) {
    n++;
    share--;
    if (q >= qs) {
      passQ = q;
      hi = q - 1;
    } else lo = q + 1;
    if (passQ !== undefined && passQ - lo < TOL) break;
    if (passQ === undefined && q >= hi0) break;
    q = passQ === undefined ? Math.min(hi, Math.ceil((lo + hi0) / 2)) : Math.floor((lo + hi) / 2);
  }
  return { n, final: passQ };
}
// ---- prediction-centred: probe the prediction, then step by `step` towards the boundary, then bisect ----
function searchPredicted(qs, start, [lo0, hi0], step, budget = 4) {
  let lo = lo0, hi = hi0, passQ, n = 0, q = Math.max(lo0, Math.min(hi0, Math.round(start)));
  let dir = 0;
  while (n < budget && lo <= hi) {
    n++;
    if (q >= qs) {
      passQ = q;
      hi = q - 1;
    } else lo = q + 1;
    if (passQ !== undefined && passQ - lo < TOL) break;
    if (passQ === undefined && q >= hi0) break;
    if (passQ === undefined) {
      // still failing: jump up by a growing step
      dir = dir >= 0 ? dir + 1 : 1;
      q = Math.min(hi0, q + step * dir);
    } else if (lo === lo0 && dir <= 0) {
      // passing and no failure seen yet: step down once, then bisect
      dir = -1;
      q = Math.max(lo0, passQ - step);
    } else q = Math.floor((lo + hi) / 2);
  }
  return { n, final: passQ };
}

const report = {};
const model = { features: FEATURES.map(([n]) => n), formats: {} };
for (const format of ["avif", "webp", "jpeg"]) {
  const data = rows.filter((r) => r.results[format] && r.results[format].q !== null);
  for (const group of ["photo", "graphic"]) {
    const g = data.filter((r) => (GRAPHIC.has(r.engineCategory) ? "graphic" : "photo") === group);
    const train = g.filter((r) => r.split === "train"), test = g.filter((r) => r.split === "test");
    if (train.length < 15 || !test.length) continue;
    const m = ridge(train.map(fx), train.map((r) => r.results[format].q), 3);
    const med = median(train.map((r) => r.results[format].q));
    const resid = train.map((r) => r.results[format].q - predictRaw(m, fx(r)));
    const sigma = Math.sqrt(resid.reduce((s, v) => s + v * v, 0) / resid.length);
    model.formats[`${format}:${group}`] = { c: +m.c.toFixed(4), w: m.w.map((v) => +v.toFixed(4)), sigma: +sigma.toFixed(2), median: med, n: train.length };
    const start = test[0].results[format].start;
    const errs = {
      currentStart: mae(test.map((r) => r.results[format].q - start)),
      trainMedian: mae(test.map((r) => r.results[format].q - med)),
      model: mae(test.map((r) => r.results[format].q - predictRaw(m, fx(r)))),
    };
    const sim = (fn) => {
      const res = test.map((r) => fn(r));
      const ok = res.filter((x) => x.final !== undefined);
      return { encodes: +(res.reduce((s, x) => s + x.n, 0) / res.length).toFixed(2), overshoot: ok.length ? +mae(ok.map((x, i) => x.final - test[res.indexOf(x)].results[format].q)).toFixed(2) : null, failed: res.length - ok.length };
    };
    const rng = RANGES[format];
    report[`${format}:${group}`] = {
      n_train: train.length,
      n_test: test.length,
      startMAE: Object.fromEntries(Object.entries(errs).map(([k, v]) => [k, +v.toFixed(2)])),
      current: sim((r) => searchCurrent(r.results[format].q, start, rng)),
      medianStartBisect: sim((r) => searchCurrent(r.results[format].q, med, rng)),
      predictedBisect: sim((r) => searchCurrent(r.results[format].q, predictRaw(m, fx(r)), rng)),
      predictedGallop: sim((r) => searchPredicted(r.results[format].q, predictRaw(m, fx(r)) + sigma * 0.5, rng, Math.max(3, Math.round(sigma)))),
    };
  }
}
for (const [k, v] of Object.entries(report)) {
  console.log(`\n== ${k}  (train ${v.n_train}, test ${v.n_test})`);
  console.log(`  start error (MAE, quality steps): current fixed ${v.startMAE.currentStart}, train median ${v.startMAE.trainMedian}, model ${v.startMAE.model}`);
  for (const s of ["current", "medianStartBisect", "predictedBisect", "predictedGallop"]) console.log(`  ${s.padEnd(18)} encodes ${v[s].encodes}  overshoot ${v[s].overshoot}  no-pass ${v[s].failed}`);
}
await writeFile(join(here, "model.json"), JSON.stringify(model, null, 2) + "\n");
// Generated TypeScript consumed by src/predictor.ts.
await writeFile(
  join(here, "../../src/predictor-model.ts"),
  `// Generated by bench/predictor/fit.mjs from bench/predictor/labels.jsonl (train split). Do not edit by hand.\n` +
    `// Ridge regression: quality ≈ c + Σ w_i · feature_i, features in this order: ${model.features.join(", ")}.\n` +
    `export const PREDICTOR_MODEL: Record<string, { c: number; w: number[]; sigma: number; median: number; n: number }> = ${JSON.stringify(model.formats, null, 2)};\n`,
);
await writeFile(join(here, "fit-report.json"), JSON.stringify(report, null, 2) + "\n");
