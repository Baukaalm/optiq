import { describe, expect, it } from "vitest";
import { formatMinQuality } from "../../src/plan.js";

describe("per-format SSIM thresholds", () => {
  it("per-format thresholds calibrated against SSIMULACRA2 (AVIF stricter, jpegli photos slightly looser)", () => {
    expect(formatMinQuality(0.975, "libwebp", "photo")).toBe(0.975);
    expect(formatMinQuality(0.975, "jpegli", "screenshot")).toBe(0.975);
    expect(formatMinQuality(0.975, "jpegli", "photo")).toBeCloseTo(0.97, 10);
    expect(formatMinQuality(0.975, "canvas-jpeg", "photo")).toBe(0.975); // the browser's encoder gets no allowance
    expect(formatMinQuality(0.975, "libavif", "photo")).toBeCloseTo(1 - 0.7 * 0.025, 10);
    expect(formatMinQuality(0.975, "libavif", "screenshot")).toBeCloseTo(1 - 0.3 * 0.025, 10);
    expect(formatMinQuality(0.99, "libavif", "photo")).toBeCloseTo(0.993, 10);
    expect(formatMinQuality(1, "libavif", "photo")).toBe(1);
  });
});
