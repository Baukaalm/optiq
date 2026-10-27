// Would an explicit alpha-channel SSIM term change decisions? For AVIF encodes of the transparent corpus images,
// compare the current score (composited on black/white) with SSIM of the alpha plane alone, and the max alpha error.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWasmBackend, initNodeCodecs } from "../../dist/node.js";
import { ssim } from "../../dist/quality.js";

const here = fileURLToPath(new URL(".", import.meta.url));
await initNodeCodecs();
const w = createWasmBackend();
const alphaAsGray = (img) => {
  const d = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = img.data[i + 3], (d[i + 3] = 255);
  return { data: d, width: img.width, height: img.height };
};
for (const f of ["transparent-illustration-1.png", "transparent-illustration-2.png", "transparent-illustration-3.png", "transparent-icon.png"]) {
  const img = await w.decode("png", new Uint8Array(await readFile(join(here, "../corpus/images", f))));
  for (const q of [25, 35, 50, 70]) {
    const out = await w.decode("avif", await w.encode("avif", img, { quality: q, speed: 7, chroma: "444", alphaBoost: 25 }));
    const composite = ssim(img, out).ssim;
    const alpha = ssim(alphaAsGray(img), alphaAsGray(out)).y;
    console.log(`${f.padEnd(32)} q${q}  composite ${composite.toFixed(4)}  alpha-plane ${alpha.toFixed(4)}`);
  }
}
