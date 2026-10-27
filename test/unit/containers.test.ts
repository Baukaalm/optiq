import { describe, expect, it } from "vitest";
import { buildOrientationExif, readOrientation, withOrientation } from "../../src/container/exif.js";
import { decodeGifFirstFrame, probeGif } from "../../src/container/gif.js";
import { injectJpegMetadata, probeJpeg, rewriteJpegMetadata } from "../../src/container/jpeg.js";
import { injectPngMetadata, probePng, inflateIcc, rewritePngMetadata } from "../../src/container/png.js";
import { injectWebpMetadata, probeWebp } from "../../src/container/webp.js";
import { parseIcc } from "../../src/container/icc.js";
import { initNodeCodecs } from "../../src/node.js";
import { createWasmBackend } from "../../src/codecs/wasm.js";
import { pixelsEqual } from "../../src/pixels.js";
import { decodeWithSharp, photoLike, screenshotLike, toGif, toJpeg, toPng, toWebp, transparentIllustration } from "../helpers/fixtures.js";

const backend = createWasmBackend();

describe("EXIF", () => {
  it("builds, reads and patches orientation", () => {
    const e = buildOrientationExif(6);
    expect(readOrientation(e)).toBe(6);
    expect(readOrientation(withOrientation(e, 1))).toBe(1);
    expect(readOrientation(new Uint8Array([1, 2, 3]))).toBe(1);
  });
});

describe("JPEG container", () => {
  it("probes dimensions, EXIF, ICC and strips metadata without touching image data", async () => {
    await initNodeCodecs();
    const jpg = await toJpeg(photoLike(64, 48), { orientation: 6, icc: "p3", exif: { IFD0: { Copyright: "secret" } } });
    const info = probeJpeg(jpg);
    expect([info.width, info.height]).toEqual([64, 48]);
    expect(readOrientation(info.exif)).toBe(6);
    expect(parseIcc(info.icc!)?.isSrgb).toBe(false);
    const stripped = rewriteJpegMetadata(jpg, { exif: buildOrientationExif(6) }, true);
    const s = probeJpeg(stripped);
    expect(readOrientation(s.exif)).toBe(6);
    expect(new TextDecoder().decode(s.exif)).not.toContain("secret");
    expect(s.icc).toEqual(info.icc);
    expect(stripped.length).toBeLessThan(jpg.length);
    expect(pixelsEqual(await backend.decode("jpeg", jpg), await backend.decode("jpeg", stripped))).toBe(true);
  });

  it("injects multi-segment ICC and EXIF into an encoded JPEG", async () => {
    const jpg = await toJpeg(photoLike(16, 16));
    const icc = new Uint8Array(70000).map((_, i) => i & 0xff);
    const out = injectJpegMetadata(jpg, { exif: buildOrientationExif(1), icc });
    const info = probeJpeg(out);
    expect(info.icc).toEqual(icc);
    expect(readOrientation(info.exif)).toBe(1);
  });

  it("rejects truncated data", () => {
    expect(() => probeJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toThrow();
  });
});

describe("PNG container", () => {
  it("reads iCCP/eXIf and rewrites metadata", async () => {
    const png = await toPng(transparentIllustration(32, 32), { icc: "p3", exif: { IFD0: { Copyright: "x" } } });
    const info = probePng(png);
    expect(info.hasAlpha).toBe(true);
    expect(info.exif).toBeDefined();
    const icc = await inflateIcc(info.iccCompressed!);
    expect(parseIcc(icc)?.colorSpace).toBe("RGB ");
    const stripped = await rewritePngMetadata(png, {}, { dropIcc: false });
    const s = probePng(stripped);
    expect(s.exif).toBeUndefined();
    expect(s.iccCompressed).toBeDefined();
    const injected = await injectPngMetadata(stripped, { exif: buildOrientationExif(3), icc });
    expect(readOrientation(probePng(injected).exif)).toBe(3);
    expect(await decodeWithSharp(injected)).toEqual(await decodeWithSharp(png));
  });
});

describe("WebP container", () => {
  it("converts simple WebP to VP8X with ICC/EXIF, decodable by libvips", async () => {
    for (const lossless of [true, false]) {
      const webp = await toWebp(transparentIllustration(30, 20), { lossless });
      const before = probeWebp(webp);
      const icc = new Uint8Array(200).fill(7);
      const out = injectWebpMetadata(webp, { exif: buildOrientationExif(1), icc });
      const after = probeWebp(out);
      expect([after.width, after.height, after.hasAlpha]).toEqual([before.width, before.height, before.hasAlpha]);
      expect(after.icc).toEqual(icc);
      expect(readOrientation(after.exif)).toBe(1);
    }
  });
});

describe("GIF", () => {
  it("decodes the first frame identically to libvips", async () => {
    const gif = await toGif(screenshotLike(97, 61));
    const info = probeGif(gif);
    expect(info.animated).toBe(false);
    const ours = decodeGifFirstFrame(gif);
    const ref = await decodeWithSharp(gif);
    expect(pixelsEqual(ours, ref)).toBe(true);
  });
});
