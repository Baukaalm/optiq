import { describe, expect, it } from "vitest";
import { ssim } from "../../src/quality.js";
import { ssim as reference } from "./quality-reference.js";
import { photoLike, rng, screenshotLike, transparentIllustration } from "../helpers/fixtures.js";

// The optimised SSIM (row-group reuse) must give the same numbers as the original straightforward version.
describe("optimised SSIM matches the reference implementation", () => {
  const distort = (img: { data: Uint8ClampedArray; width: number; height: number }, amp: number, seed: number) => {
    const r = rng(seed);
    return { ...img, data: img.data.map((v, i) => (i % 4 === 3 ? (v < 255 ? Math.min(255, v + r() * 30) : v) : v + (r() - 0.5) * amp)) };
  };
  const cases = [
    ["photo 333x217", photoLike(333, 217)],
    ["screenshot 400x301", screenshotLike(400, 301)],
    ["transparent 130x97", transparentIllustration(130, 97)],
    ["tiny 5x3", photoLike(5, 3)],
    ["8x8", photoLike(8, 8)],
    ["9x13", photoLike(9, 13)],
  ] as const;
  for (const [name, img] of cases) {
    it(name, () => {
      for (const amp of [0, 6, 40]) {
        const other = distort(img, amp, amp + 1);
        const a = ssim(img, other);
        const b = reference(img, other);
        for (const k of ["y", "cb", "cr", "activeShare"] as const) expect(a[k]).toBeCloseTo(b[k], 10);
        // The only intended difference: images with alpha are additionally bounded by the alpha plane's SSIM.
        expect(a.ssim).toBeCloseTo(Math.min(b.ssim, a.alpha ?? Infinity), 10);
      }
    });
  }
});
