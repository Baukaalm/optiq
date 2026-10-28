import { beforeAll, describe, expect, it } from "vitest";
import { classify } from "../../src/classify.js";
import { createWasmBackend } from "../../src/codecs/wasm.js";
import { optimize } from "../../src/engine.js";
import { initNodeCodecs } from "../../src/node.js";
import { resolveOptions } from "../../src/options.js";
import { predictStart } from "../../src/predictor.js";
import { photoLike, screenshotLike, toJpeg } from "../helpers/fixtures.js";

beforeAll(() => initNodeCodecs());

describe("quality predictor", () => {
  it("is deterministic and stays inside each codec's quality range", () => {
    for (const img of [photoLike(320, 240, 1, 10), screenshotLike(640, 400)]) {
      const { category, features } = classify(img);
      for (const f of ["avif", "webp", "jpeg"] as const) {
        const a = predictStart(f, category, features, "model");
        expect(a).toEqual(predictStart(f, category, features, "model"));
        expect(a!.start).toBeGreaterThan(0);
        expect(a!.start).toBeLessThan(110);
        expect(a!.step).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("is on by default only in fast mode", () => {
    expect(resolveOptions({ mode: "fast" }).searchStart).toBe("model");
    expect(resolveOptions({ mode: "balanced" }).searchStart).toBe("fixed");
    expect(resolveOptions({ mode: "visually-lossless" }).searchStart).toBe("fixed");
  });

  it("never weakens the quality guarantee (every start variant meets the threshold)", async () => {
    const jpg = await toJpeg(photoLike(256, 192, 2, 10), { quality: 95 });
    for (const searchStart of ["fixed", "category", "model"] as const) {
      const r = await optimize(jpg, { mode: "fast", searchStart }, { backend: createWasmBackend() });
      expect(r.report.constraintsMet).toBe(true);
      expect(r.report.qualityMetric!).toBeGreaterThanOrEqual(0.975 - 1e-9);
    }
  });
});
