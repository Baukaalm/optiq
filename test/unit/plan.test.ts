import { describe, expect, it } from "vitest";
import { formatMinQuality } from "../../src/plan.js";

describe("per-format SSIM thresholds", () => {
  it("holds AVIF closer to 1 than JPEG/WebP (calibrated against SSIMULACRA2)", () => {
    expect(formatMinQuality(0.975, "webp", "photo")).toBe(0.975);
    expect(formatMinQuality(0.975, "jpeg", "screenshot")).toBe(0.975);
    expect(formatMinQuality(0.975, "avif", "photo")).toBeCloseTo(1 - 0.7 * 0.025, 10);
    expect(formatMinQuality(0.975, "avif", "screenshot")).toBeCloseTo(1 - 0.3 * 0.025, 10);
    expect(formatMinQuality(0.99, "avif", "photo")).toBeCloseTo(0.993, 10);
    expect(formatMinQuality(1, "avif", "photo")).toBe(1);
  });
});
