import { beforeAll, describe, expect, it } from "vitest";
import { withFallback } from "../../src/codecs/fallback.js";
import type { CodecBackend } from "../../src/codecs/types.js";
import { createWasmBackend } from "../../src/codecs/wasm.js";
import { readOrientation } from "../../src/container/exif.js";
import { probeJpeg } from "../../src/container/jpeg.js";
import { probePng } from "../../src/container/png.js";
import { probeWebp } from "../../src/container/webp.js";
import { optimize, type EngineOutput } from "../../src/engine.js";
import { SmartCompressError } from "../../src/errors.js";
import { initNodeCodecs } from "../../src/node.js";
import { applyOrientation, pixelsEqual, type RawImage } from "../../src/pixels.js";
import { probe } from "../../src/probe.js";
import { ssim } from "../../src/quality.js";
import type { SmartCompressOptions } from "../../src/types.js";
import { animated, gradient, photoLike, screenshotLike, toGif, toJpeg, toPng, toWebp, transparentIllustration } from "../helpers/fixtures.js";

const wasm = createWasmBackend();
beforeAll(() => initNodeCodecs());

const run = (input: Uint8Array, options?: SmartCompressOptions, backend: CodecBackend = wasm, signal?: AbortSignal) => optimize(input, options, { backend, signal });
const outBytes = (input: Uint8Array, o: EngineOutput) => o.bytes ?? input;
const decodeOut = async (input: Uint8Array, o: EngineOutput): Promise<RawImage> => {
  const b = outBytes(input, o);
  const info = await probe(b);
  return wasm.decode(info.format as "png", b);
};
async function expectError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(SmartCompressError);
  await expect(p).rejects.toMatchObject({ code });
}

describe("lossless mode", () => {
  it("PNG screenshot: output decodes to identical pixels and is not larger", async () => {
    const img = screenshotLike(320, 200);
    const png = await toPng(img);
    const r = await run(png, { mode: "lossless" });
    expect(r.report.outputBytes).toBeLessThanOrEqual(png.length);
    expect(r.report.qualityMetricName).toBe("exact");
    expect(pixelsEqual(await decodeOut(png, r), img)).toBe(true);
    expect(r.report.candidates.every((c) => c.passed || c.note?.includes("verification"))).toBe(true);
  });

  it("transparent PNG keeps alpha exactly, including colour under transparent pixels", async () => {
    const img = transparentIllustration(128, 96);
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3] === 0) img.data[i] = 77; // hidden colour
    const png = await toPng(img);
    const r = await run(png, { mode: "lossless" });
    expect(pixelsEqual(await decodeOut(png, r), img)).toBe(true);
    expect(r.report.outputFormat).not.toBe("jpeg");
  });

  it("JPEG photo: only container-level optimisation, never a lossy re-encode", async () => {
    const jpg = await toJpeg(photoLike(256, 192), { exif: { IFD0: { Copyright: "c", ImageDescription: "x".repeat(4000) } } });
    const keep = await run(jpg, { mode: "lossless" });
    expect(keep.report.usedOriginal).toBe(true);
    const strip = await run(jpg, { mode: "lossless", preserveMetadata: false });
    expect(strip.report.outputFormat).toBe("jpeg");
    expect(strip.report.outputBytes).toBeLessThan(jpg.length - 4000);
    expect(strip.report.metadata.exif).toBe("removed");
    expect(pixelsEqual(await decodeOut(jpg, strip), await wasm.decode("jpeg", jpg))).toBe(true);
  });

  it("refuses to resize unless explicitly allowed", async () => {
    const png = await toPng(screenshotLike(200, 100));
    await expectError(run(png, { mode: "lossless", maxWidthOrHeight: 50 }), "INCOMPATIBLE_OPTIONS");
    const r = await run(png, { mode: "lossless", maxWidthOrHeight: 50, allowLossyResize: true });
    expect([r.report.width, r.report.height]).toEqual([50, 25]);
  });

  it("rejects explicit JPEG output in lossless mode", async () => {
    await expectError(run(await toPng(screenshotLike(40, 40)), { mode: "lossless", targetFormat: "jpeg" }), "INCOMPATIBLE_OPTIONS");
    await expectError(run(await toPng(screenshotLike(40, 40)), { mode: "lossless", targetFormat: "avif" }), "INCOMPATIBLE_OPTIONS");
  });

  it("lossless WebP input is handled", async () => {
    const img = screenshotLike(120, 80);
    const webp = await toWebp(img, { lossless: true });
    const r = await run(webp, { mode: "lossless" });
    expect(pixelsEqual(await decodeOut(webp, r), img)).toBe(true);
  });
});

describe("perceptual modes", () => {
  for (const mode of ["balanced", "visually-lossless"] as const) {
    it(`${mode}: photo output meets the SSIM threshold and shrinks`, async () => {
      const img = photoLike(320, 240);
      const jpg = await toJpeg(img, { quality: 95 });
      const r = await run(jpg, { mode });
      const ref = await wasm.decode("jpeg", jpg);
      const out = await decodeOut(jpg, r);
      const threshold = mode === "balanced" ? 0.975 : 0.99;
      expect(r.report.constraintsMet).toBe(true);
      expect(ssim(ref, out).ssim).toBeGreaterThanOrEqual(threshold - 1e-9);
      expect(r.report.outputBytes).toBeLessThanOrEqual(jpg.length);
      expect(r.report.candidates.length).toBeLessThanOrEqual(mode === "balanced" ? 11 : 17);
      expect(["photo", "gradient"]).toContain(r.report.category);
    });
  }

  it("respects maxWidthOrHeight and keeps aspect ratio", async () => {
    const jpg = await toJpeg(photoLike(400, 300));
    const r = await run(jpg, { maxWidthOrHeight: 100 });
    expect([r.report.width, r.report.height]).toEqual([100, 75]);
    const out = await decodeOut(jpg, r);
    expect([out.width, out.height]).toEqual([100, 75]);
  });

  it("reports an unmet maxOutputBytes instead of silently violating quality", async () => {
    const jpg = await toJpeg(photoLike(256, 256));
    const r = await run(jpg, { maxOutputBytes: 200 });
    expect(r.report.constraintsMet).toBe(false);
    expect(r.report.unmetConstraints[0]).toMatchObject({ constraint: "maxOutputBytes", limit: 200 });
    await expectError(run(jpg, { maxOutputBytes: 200, onUnmetConstraints: "throw" }), "CONSTRAINTS_UNSATISFIABLE");
  });

  it("transparent input never becomes JPEG; explicit JPEG is rejected", async () => {
    const png = await toPng(transparentIllustration(160, 120));
    const r = await run(png);
    expect(r.report.outputFormat).not.toBe("jpeg");
    expect(r.report.candidates.some((c) => c.format === "jpeg")).toBe(false);
    await expectError(run(png, { targetFormat: "jpeg" }), "INCOMPATIBLE_OPTIONS");
  });

  it("PNG declared with alpha but fully opaque may become JPEG", async () => {
    const png = await toPng(photoLike(200, 150));
    expect((await probe(png)).hasAlpha).toBe(true);
    const r = await run(png, { autoFormats: ["jpeg"] });
    expect(r.report.outputFormat, JSON.stringify(r.report.candidates)).toBe("jpeg");
  });

  it("allowFormatConversion: false keeps the input format", async () => {
    const png = await toPng(photoLike(160, 120));
    const r = await run(png, { allowFormatConversion: false });
    expect(r.report.outputFormat).toBe("png");
    await expectError(run(png, { allowFormatConversion: false, targetFormat: "webp" }), "INCOMPATIBLE_OPTIONS");
  });

  it("returns the original when re-encoding does not help", async () => {
    const jpg = await toJpeg(photoLike(64, 64), { quality: 40 });
    const r = await run(jpg, { mode: "visually-lossless", autoFormats: ["jpeg"] });
    expect(r.report.usedOriginal).toBe(true);
    expect(r.bytes).toBeUndefined();
    expect(r.report.sizeReductionRatio).toBe(0);
  });

  it("fixed strategy encodes each codec once", async () => {
    const jpg = await toJpeg(photoLike(128, 128));
    const r = await run(jpg, { searchStrategy: "fixed", autoFormats: ["jpeg", "webp"] });
    expect(r.report.candidates.filter((c) => c.qualityMetric === "ssim").length).toBe(2);
  });

  it("static GIF is decoded and optimised; tiny 1x1 and 3x2 images work", async () => {
    const gif = await toGif(screenshotLike(120, 90));
    const r = await run(gif);
    expect(r.report.outputFormat).not.toBe("gif");
    expect(r.report.outputBytes).toBeLessThan(gif.length);
    for (const [w, h] of [[1, 1], [3, 2]]) {
      const png = await toPng(photoLike(w, h));
      const t = await run(png);
      expect([t.report.width, t.report.height]).toEqual([w, h]);
    }
  });

  it("gradient is classified and held to a stricter threshold", async () => {
    const png = await toPng(gradient(256, 256));
    const r = await run(png);
    expect(r.report.category).toBe("gradient");
    expect(r.report.qualityMetric!).toBeGreaterThanOrEqual(0.975 + 0.0125 - 1e-9);
  });

  it("large image (12 MP) completes with a bounded number of encodes", async () => {
    const img = photoLike(4000, 3000, 9);
    const jpg = await toJpeg(img, { quality: 95 });
    const t = performance.now();
    const r = await run(jpg, { mode: "balanced", autoFormats: ["jpeg", "webp"] });
    expect(r.report.outputBytes).toBeLessThan(jpg.length);
    // Search ran on the tile mosaic; the chosen output was encoded and verified at full size.
    const proxies = r.report.candidates.filter((c) => c.proxy);
    expect(proxies.length).toBeGreaterThan(0);
    expect(r.report.candidates.length - proxies.length).toBeLessThanOrEqual(4);
    const out = await decodeOut(jpg, r);
    expect([out.width, out.height]).toEqual([4000, 3000]);
    expect(ssim(await wasm.decode("jpeg", jpg), out).ssim).toBeGreaterThanOrEqual(0.975);
    console.log(`12MP balanced jpeg+webp: ${Math.round(performance.now() - t)} ms, ${r.report.candidates.length} candidates`);
  }, 180_000);
});

describe("orientation, animation, metadata", () => {
  it("EXIF orientation is baked into re-encoded pixels and kept in passthrough", async () => {
    const img = photoLike(120, 80);
    const jpg = await toJpeg(img, { orientation: 6, quality: 97 });
    const r = await run(jpg, { autoFormats: ["webp"] });
    expect([r.report.width, r.report.height]).toEqual([80, 120]);
    expect(r.report.metadata.orientation).toBe("baked");
    const out = await decodeOut(jpg, r);
    expect([out.width, out.height]).toEqual([80, 120]);
    const expected = applyOrientation(await wasm.decode("jpeg", jpg), 6);
    expect(ssim(expected, out).ssim).toBeGreaterThan(0.95);
    expect(readOrientation(probeWebp(r.bytes!).exif)).toBe(1); // EXIF kept, orientation reset

    const lossless = await run(jpg, { mode: "lossless", preserveMetadata: false });
    expect(lossless.report.metadata.orientation).toBe("kept");
    expect(readOrientation(probeJpeg(outBytes(jpg, lossless)).exif)).toBe(6);
  });

  it("animated GIF/WebP are preserved, explicit conversion is rejected, flattening is opt-in", async () => {
    for (const f of ["gif", "webp"] as const) {
      const anim = await animated(f, 64, 48);
      expect((await probe(anim)).animated).toBe(true);
      const r = await run(anim);
      expect(r.report.outputFormat).toBe(f);
      expect((await probe(outBytes(anim, r))).animated).toBe(true);
      await expectError(run(anim, { targetFormat: "png" }), "INCOMPATIBLE_OPTIONS");
      const flat = await run(anim, { preserveAnimation: false, targetFormat: "png" });
      expect((await probe(flat.bytes!)).animated).toBe(false);
      expect(flat.report.warnings.join(" ")).toMatch(/flattened/);
    }
  });

  it("preserveMetadata keeps EXIF and ICC in converted output; false removes EXIF but keeps a non-sRGB profile", async () => {
    const jpg = await toJpeg(photoLike(160, 120), { icc: "p3", exif: { IFD0: { Copyright: "gps-like-secret" } } });
    const keep = await run(jpg, { autoFormats: ["webp", "avif"] });
    expect(keep.report.outputFormat).toBe("webp");
    expect(keep.report.warnings.join(" ")).toMatch(/AVIF output skipped/);
    const k = probeWebp(keep.bytes!);
    expect(new TextDecoder().decode(k.exif)).toContain("gps-like-secret");
    expect(k.icc).toBeDefined();
    expect(keep.report.metadata).toMatchObject({ exif: "kept", iccProfile: "kept" });

    const strip = await run(jpg, { targetFormat: "png", preserveMetadata: false });
    const s = probePng(strip.bytes!);
    expect(s.exif).toBeUndefined();
    expect(s.iccCompressed).toBeDefined();
    expect(strip.report.metadata).toMatchObject({ exif: "removed", iccProfile: "kept" });
  });

  it("AVIF output signals sRGB via nclx, so an sRGB ICC profile may be omitted there", async () => {
    const jpg = await toJpeg(photoLike(64, 64), { icc: "srgb" });
    const r = await run(jpg, { targetFormat: "avif", preserveMetadata: false });
    const { probeIsobmff } = await import("../../src/container/isobmff.js");
    expect(probeIsobmff(r.bytes!).nclx).toMatchObject({ primaries: 1, transfer: 13 });
    expect(r.report.metadata.iccProfile).toBe("dropped-srgb");
    const p3 = await toJpeg(photoLike(64, 64), { icc: "p3" });
    await expectError(run(p3, { targetFormat: "avif" }), "INCOMPATIBLE_OPTIONS");
  });

  it("drops an sRGB profile only when metadata stripping is requested", async () => {
    const jpg = await toJpeg(photoLike(64, 64), { icc: "srgb" });
    const r = await run(jpg, { preserveMetadata: false, autoFormats: ["webp"] });
    expect(r.report.metadata.iccProfile).toBe("dropped-srgb");
    expect(probeWebp(r.bytes!).icc).toBeUndefined();
  });
});

describe("validation and safety", () => {
  it("detects format from content, not extension/MIME", async () => {
    const png = await toPng(screenshotLike(30, 30));
    expect((await run(png)).report.originalFormat).toBe("png");
  });

  it("rejects unsupported, malformed, empty and HEIF input with typed errors", async () => {
    await expectError(run(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])), "UNSUPPORTED_FORMAT");
    await expectError(run(new Uint8Array(0)), "INVALID_INPUT");
    const png = await toPng(screenshotLike(30, 30));
    await expectError(run(png.subarray(0, 40)), "MALFORMED_INPUT");
    const jpg = await toJpeg(photoLike(30, 30));
    await expectError(run(jpg.subarray(0, jpg.length - 200)), "MALFORMED_INPUT"); // truncated: no EOI
    const heic = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63]);
    await expectError(run(heic), "UNSUPPORTED_FORMAT");
  });

  it("passes SVG through untouched and refuses to rasterize it", async () => {
    const svg = new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    const r = await run(svg);
    expect(r.report).toMatchObject({ usedOriginal: true, outputFormat: "svg", mimeType: "image/svg+xml" });
    await expectError(run(svg, { targetFormat: "png" }), "INCOMPATIBLE_OPTIONS");
  });

  it("enforces pixel and byte limits before decoding", async () => {
    // PNG header claiming 100000 x 100000 pixels.
    const png = await toPng(screenshotLike(10, 10));
    const bomb = png.slice();
    new DataView(bomb.buffer).setUint32(16, 100000);
    new DataView(bomb.buffer).setUint32(20, 100000);
    await expectError(run(bomb), "INPUT_TOO_LARGE");
    await expectError(run(png, { maxInputBytes: 10 }), "INPUT_TOO_LARGE");
  });

  it("validates options", async () => {
    const png = await toPng(screenshotLike(10, 10));
    await expectError(run(png, { minQuality: 2 }), "INVALID_OPTIONS");
    await expectError(run(png, { mode: "magic" as never }), "INVALID_OPTIONS");
    await expectError(run(png, { targetFormat: "bmp" as never }), "INVALID_OPTIONS");
  });

  it("aborts", async () => {
    const ac = new AbortController();
    ac.abort();
    await expectError(run(await toPng(screenshotLike(10, 10)), {}, wasm, ac.signal), "ABORTED");
  });

  it("emits ordered progress stages", async () => {
    const stages: string[] = [];
    await optimize(await toJpeg(photoLike(64, 64)), {}, { backend: wasm, onProgress: (e) => stages.push(e.stage) });
    expect(stages[0]).toBe("probing");
    expect(stages.at(-1)).toBe("done");
    expect(stages).toContain("encoding");
  });
});

describe("codec fallback", () => {
  const failing = (formats: string[]): CodecBackend => ({
    ...wasm,
    name: "wasm",
    encode: (f, img, s) => (formats.includes(f) ? Promise.reject(new Error("CompileError: wasm blocked by CSP")) : wasm.encode(f, img, s)),
  });
  const stand_in: CodecBackend = { ...wasm, name: "canvas", codecName: (f) => `canvas-${f}` };

  it("uses and reports the fallback backend", async () => {
    const r = await run(await toJpeg(photoLike(96, 96)), { autoFormats: ["webp"] }, withFallback(failing(["webp"]), stand_in));
    expect(r.report.fallbacks.length).toBeGreaterThanOrEqual(1);
    expect(r.report.fallbacks.join("\n")).toMatch(/webp encode: wasm failed .*used canvas/);
    expect(r.report.codec).toBe("canvas-webp");
  });

  it("skips an unavailable codec and continues with the others", async () => {
    const r = await run(await toJpeg(photoLike(96, 96)), { autoFormats: ["webp", "jpeg"], minSavingsRatio: 0 }, withFallback(failing(["webp"]), undefined));
    expect(r.report.candidates.some((c) => c.format === "webp")).toBe(false);
    expect(r.report.warnings.join()).toMatch(/libwebp unavailable, skipped: .*CSP/);
  });

  it("fails with CODEC_UNAVAILABLE when no encoder works and the original cannot be returned", async () => {
    const p = run(await toJpeg(photoLike(64, 64)), { targetFormat: "webp" }, withFallback(failing(["webp"]), undefined));
    await expectError(p, "CODEC_UNAVAILABLE");
  });
});
