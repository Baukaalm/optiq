/**
 * `optiq-image/node` — Node.js support (tests, benchmarks, server-side use). jSquash fetches its .wasm via `fetch(import.meta.url)`,
 * which does not work for file: URLs in Node, so compile the modules from disk and hand them over explicitly.
 *
 * @packageDocumentation
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { initJpegli } from "./codecs/jpegli.js";
import { initSvgRenderer } from "./svg.js";
import { createWasmBackend } from "./codecs/wasm.js";
import type { CodecBackend } from "./codecs/types.js";
import { optimize, type EngineContext, type EngineOutput } from "./engine.js";
import type { OptiqOptions } from "./types.js";

let ready: Promise<void> | undefined;

function polyfillImageData() {
  if (typeof globalThis.ImageData !== "undefined") return;
  class ImageDataPolyfill {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    readonly colorSpace = "srgb";
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  }
  (globalThis as unknown as { ImageData: unknown }).ImageData = ImageDataPolyfill;
}

export function initNodeCodecs(): Promise<void> {
  ready ??= (async () => {
    polyfillImageData();
    const require = createRequire(import.meta.url);
    const root = (pkg: string) => dirname(require.resolve(`@jsquash/${pkg}/package.json`));
    const bytes = (pkg: string, file: string) => readFile(join(root(pkg), file));
    const mod = async (pkg: string, file: string) => WebAssembly.compile(await bytes(pkg, file));
    const [jd, we, wd, ae, ad, pe, pd, ox, rs] = await Promise.all([
      import("@jsquash/jpeg/decode.js"),
      import("@jsquash/webp/encode.js"),
      import("@jsquash/webp/decode.js"),
      import("@jsquash/avif/encode.js"),
      import("@jsquash/avif/decode.js"),
      import("@jsquash/png/encode.js"),
      import("@jsquash/png/decode.js"),
      import("@jsquash/oxipng/optimise.js"),
      import("@jsquash/resize"),
    ]);
    await initSvgRenderer(await WebAssembly.compile(await readFile(require.resolve("@resvg/resvg-wasm/index_bg.wasm"))));
    await initJpegli(await WebAssembly.compile(await readFile(new URL("../vendor/jpegli/jpegli_enc.wasm", import.meta.url))));
    await jd.init(await mod("jpeg", "codec/dec/mozjpeg_dec.wasm"));
    await we.init(await mod("webp", "codec/enc/webp_enc_simd.wasm"));
    await wd.init(await mod("webp", "codec/dec/webp_dec.wasm"));
    await ae.init(await mod("avif", "codec/enc/avif_enc.wasm"));
    await ad.init(await mod("avif", "codec/dec/avif_dec.wasm"));
    const png = await bytes("png", "codec/pkg/squoosh_png_bg.wasm");
    await pe.init(png);
    await pd.init(png);
    await ox.init(await bytes("oxipng", "codec/pkg/squoosh_oxipng_bg.wasm"));
    await rs.initResize(await bytes("resize", "lib/resize/pkg/squoosh_resize_bg.wasm"));
  })();
  return ready;
}

/** Optimise bytes in Node with the WASM codecs (single-threaded; no Worker). */
export async function optimizeInNode(
  input: Uint8Array,
  options?: OptiqOptions,
  ctx: Partial<EngineContext> = {},
): Promise<EngineOutput> {
  await initNodeCodecs();
  const backend: CodecBackend = ctx.backend ?? createWasmBackend();
  return optimize(input, options, { ...ctx, backend });
}

export { createWasmBackend };
export type { CodecBackend, EncodeSettings } from "./codecs/types.js";
export type { RawImage } from "./pixels.js";
export type { EngineContext, EngineOutput, EngineReport, TimingPhase } from "./engine.js";
export { collectImages, IMAGE_EXTENSIONS, optimizeFilesOnDisk } from "./files.js";
export type { DiskFileResult, DiskOptions, DiskResult } from "./files.js";
