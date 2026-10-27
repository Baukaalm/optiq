// Does lossy AVIF alpha leave visible "haze" where the input is fully transparent? SSIM cannot see it, so measure
// directly: over pixels with input alpha 0, the share that become non-zero and the maximum alpha, per alphaBoost.
// Usage: node bench/audit/avif-alpha.mjs
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWasmBackend, initNodeCodecs } from "../../dist/node.js";

const here = fileURLToPath(new URL(".", import.meta.url));
await initNodeCodecs();
const w = createWasmBackend();
const files = ["transparent-illustration-1.png", "transparent-illustration-2.png", "transparent-illustration-3.png", "transparent-icon.png"];
for (const f of files) {
  const img = await w.decode("png", new Uint8Array(await readFile(join(here, "../corpus/images", f))));
  for (const q of [30, 45, 60]) {
    const cells = [];
    for (const boost of [0, 25]) {
      const enc = await w.encode("avif", img, { quality: q, speed: 7, chroma: "444", alphaBoost: boost });
      const out = await w.decode("avif", enc);
      let zero = 0, haze = 0, max = 0, edge = 0;
      for (let i = 3; i < img.data.length; i += 4) {
        if (img.data[i] === 0) {
          zero++;
          if (out.data[i] > 0) haze++;
          max = Math.max(max, out.data[i]);
        } else edge = Math.max(edge, Math.abs(img.data[i] - out.data[i]));
      }
      cells.push(`boost${boost}: ${enc.length} B, haze ${((100 * haze) / zero).toFixed(2)}% max α ${max}, max α err elsewhere ${edge}`);
    }
    console.log(`${f.padEnd(32)} q${q}  ${cells.join("  |  ")}`);
  }
}
