// Shared evaluation: every output (ours and baselines) is decoded with the same WASM decoders and scored with the
// same SSIM implementation against the same reference (decoded, EXIF-oriented input), resized when needed.
import { initNodeCodecs, createWasmBackend } from "../dist/node.js";
import { probe } from "../dist/probe.js";
import { ssim } from "../dist/quality.js";
import { applyOrientation, pixelsEqual } from "../dist/pixels.js";
import { decodeGifFirstFrame } from "../dist/container/gif.js";

let backend;
export async function decoder() {
  await initNodeCodecs();
  backend ??= createWasmBackend();
  return backend;
}

export async function decodeOriented(bytes) {
  const b = await decoder();
  const info = await probe(bytes);
  const img = info.format === "gif" ? decodeGifFirstFrame(bytes) : await b.decode(info.format, bytes);
  return { img: applyOrientation(img, info.orientation), format: info.format };
}

export async function score(reference, outBytes) {
  const { img, format } = await decodeOriented(outBytes);
  if (img.width !== reference.width || img.height !== reference.height) return { format, exact: false, ssim: null, note: `size ${img.width}x${img.height}` };
  const exact = pixelsEqual(reference, img);
  return { format, exact, ssim: exact ? 1 : ssim(reference, img).ssim };
}
