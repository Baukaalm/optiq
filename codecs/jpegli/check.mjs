// Checks that two jpegli WASM builds encode identically: the committed vendor/jpegli and a fresh build from the
// pinned sources (CI builds it in the official emscripten/emsdk container). The .wasm binaries may differ between
// hosts (different LLVM builds); the encoded JPEG bytes must not.
// Usage: node codecs/jpegli/check.mjs <fresh-dir> [committed-dir]
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [fresh, committed = "vendor/jpegli"] = process.argv.slice(2).map((p) => resolve(p));
if (!fresh) throw new Error("usage: node codecs/jpegli/check.mjs <fresh-dir> [committed-dir]");

async function load(dir) {
  const wasm = await readFile(join(dir, "jpegli_enc.wasm"));
  const { default: create } = await import(pathToFileURL(join(dir, "jpegli_enc.js")).href);
  const module = await WebAssembly.compile(wasm);
  return { wasm, m: await create({ instantiateWasm: (imports, done) => (WebAssembly.instantiate(module, imports).then(done), {}) }) };
}

// Deterministic test images: smooth gradient, hard edges, and pseudo-random texture.
function image(kind, w, h) {
  const d = new Uint8Array(w * h * 4);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (kind === "gradient") d.set([(x * 255) / w, (y * 255) / h, ((x + y) * 128) / (w + h), 255], i);
      else if (kind === "edges") d.set(((x >> 4) + (y >> 4)) % 2 ? [20, 30, 200, 255] : [250, 240, 10, 255], i);
      else d.set([rnd(), (rnd() + x) & 255, (rnd() + y) & 255, 255], i);
    }
  return d;
}

function encode(m, data, w, h, q, chroma) {
  const ptr = m._malloc(data.length);
  m.HEAPU8.set(data, ptr);
  const n = m._jpegli_encode(ptr, w, h, q, chroma, 2);
  m._free(ptr);
  if (!n) throw new Error("encode failed");
  const out = m.HEAPU8.slice(m._jpegli_output(), m._jpegli_output() + n);
  m._jpegli_free_output();
  return out;
}

const a = await load(fresh), b = await load(committed);
let checked = 0, differ = 0;
for (const kind of ["gradient", "edges", "texture"])
  for (const [w, h] of [[64, 48], [333, 217], [800, 600]])
    for (const q of [40, 75, 90, 98])
      for (const chroma of [420, 444]) {
        const img = image(kind, w, h);
        const x = encode(a.m, img, w, h, q, chroma), y = encode(b.m, img, w, h, q, chroma);
        checked++;
        if (x.length !== y.length || x.some((v, i) => v !== y[i])) {
          differ++;
          console.log(`DIFF ${kind} ${w}x${h} q${q} ${chroma}: ${x.length} vs ${y.length} bytes`);
        }
      }
console.log(`.wasm binaries ${Buffer.compare(a.wasm, b.wasm) === 0 ? "identical" : "differ (expected across hosts)"}`);
console.log(`${checked} encodes compared, ${differ} differ`);
process.exit(differ ? 1 : 0);
