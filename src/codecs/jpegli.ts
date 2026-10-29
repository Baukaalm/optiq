/**
 * Google's jpegli JPEG encoder (BSD-3-Clause), compiled to WebAssembly by codecs/jpegli/build.sh into vendor/jpegli/.
 * Replaces MozJPEG for encoding: on the benchmark and a held-out set it needed 5–14% fewer bytes for photos at equal
 * SSIMULACRA2 (bench/jpegli-compare.mjs), and encodes 4–10× faster in WASM. Decoding stays with jSquash (libjpeg-turbo).
 */
import type { JpegliModule } from "../../vendor/jpegli/jpegli_enc.js";

let module: Promise<JpegliModule> | undefined;

/** Optional: hand over a compiled module (Node, where fetching file: URLs does not work). */
export function initJpegli(wasm?: WebAssembly.Module): Promise<JpegliModule> {
  module ??= import("../../vendor/jpegli/jpegli_enc.js").then((m) =>
    m.default(
      wasm
        ? {
            instantiateWasm(imports, done) {
              void WebAssembly.instantiate(wasm, imports).then(done);
              return {};
            },
          }
        : undefined,
    ),
  );
  return module;
}

/** Encode RGBA pixels (alpha must be opaque; it is ignored). */
export async function encodeJpegli(data: Uint8ClampedArray, width: number, height: number, quality: number, chroma: "420" | "444"): Promise<Uint8Array> {
  const m = await initJpegli();
  const ptr = m._malloc(data.length);
  try {
    m.HEAPU8.set(data, ptr);
    const n = m._jpegli_encode(ptr, width, height, quality, chroma === "444" ? 444 : 420, 2);
    if (!n) throw new Error("jpegli encoding failed");
    const out = m._jpegli_output();
    return m.HEAPU8.slice(out, out + n);
  } finally {
    m._free(ptr);
    m._jpegli_free_output();
  }
}
