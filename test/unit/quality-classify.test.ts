import { describe, expect, it } from "vitest";
import { classify } from "../../src/classify.js";
import { ssim } from "../../src/quality.js";
import { gradient, photoLike, rng, screenshotLike, transparentIllustration } from "../helpers/fixtures.js";

describe("SSIM", () => {
  it("is 1 for identical images and decreases with noise", () => {
    const a = photoLike(64, 64);
    expect(ssim(a, a).ssim).toBeCloseTo(1, 10);
    const r = rng(5);
    const noisy = (amp: number) => ({ ...a, data: a.data.map((v, i) => (i % 4 === 3 ? v : v + (r() - 0.5) * amp)) });
    const s1 = ssim(a, noisy(10)).ssim;
    const s2 = ssim(a, noisy(60)).ssim;
    expect(s1).toBeLessThan(1);
    expect(s2).toBeLessThan(s1);
  });

  it("ignores colour under fully transparent pixels but sees alpha changes", () => {
    const a = transparentIllustration(64, 64);
    const hidden = { ...a, data: a.data.map((v, i) => (i % 4 !== 3 && a.data[i - (i % 4) + 3] === 0 ? 255 - v : v)) };
    expect(ssim(a, hidden).ssim).toBeCloseTo(1, 10);
    const alphaChanged = { ...a, data: a.data.map((v, i) => (i % 4 === 3 ? Math.min(255, v + 120) : v)) };
    expect(ssim(a, alphaChanged).ssim).toBeLessThan(0.95);
  });

  it("bounds the score by alpha-plane SSIM so alpha errors cannot hide behind compositing", () => {
    const a = transparentIllustration(96, 96);
    // Add faint alpha haze where the image is fully transparent, and nowhere else.
    const hazy = { ...a, data: a.data.map((v, i) => (i % 4 === 3 && v === 0 ? 24 : v)) };
    const r = ssim(a, hazy);
    expect(r.alpha).toBeDefined();
    expect(r.ssim).toBeLessThanOrEqual(r.alpha!);
    expect(r.alpha!).toBeLessThan(0.99);
  });

  it("handles images smaller than the window", () => {
    const a = photoLike(3, 2);
    expect(ssim(a, a).ssim).toBeCloseTo(1, 10);
  });

  it("rejects mismatched dimensions", () => {
    expect(() => ssim(photoLike(4, 4), photoLike(5, 4))).toThrow();
  });
});

describe("classifier", () => {
  it("is deterministic and separates synthetic categories", () => {
    expect(classify(photoLike(400, 300, 1, 12)).category).toBe("photo");
    expect(classify(screenshotLike(800, 600)).category).toMatch(/screenshot|text-graphic/);
    expect(classify(transparentIllustration(300, 300)).category).toBe("transparent-illustration");
    expect(classify(gradient(512, 512)).category).toBe("gradient");
    const img = screenshotLike(640, 480);
    expect(classify(img)).toEqual(classify(img));
  });
});
