// Would jpegli beat MozJPEG for Optiq? Rate-quality comparison on the same images.
// MozJPEG: Optiq's WASM encoder. jpegli: native `cjpegli` built from github.com/google/jpegli (pass its path in
// CJPEGLI). Both outputs are decoded with the same standard decoder (Optiq's libjpeg-turbo-based WASM decoder, as a
// browser would) — jpegli's own high-precision decoder would flatter it. Quality: libjxl's `ssimulacra2`.
// Chroma subsampling as in the engine: 4:2:0 for photos, 4:4:4 for graphics. For each image we interpolate the
// bytes each encoder needs to reach SSIMULACRA2 70/75/80/85/90 and compare.
// Images: opaque benchmark images (≤ 4 MP) and the predictor corpus' held-out split.
// Usage: CJPEGLI=/path/to/cjpegli node bench/jpegli-compare.mjs → bench/results/jpegli-compare.jsonl + summary
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const here = fileURLToPath(new URL(".", import.meta.url));
const GRID = [50, 60, 65, 70, 75, 80, 84, 88, 91, 94, 97];
const TARGETS = [70, 75, 80, 85, 90];

if (isMainThread) {
  if (!process.env.CJPEGLI) throw new Error("Set CJPEGLI to the cjpegli binary");
  const bench = JSON.parse(await readFile(join(here, "corpus/manifest.json"), "utf8")).images.map((m) => ({ set: "bench", path: join(here, "corpus/images", m.file), file: m.file }));
  const held = JSON.parse(await readFile(join(here, "predictor/manifest.json"), "utf8"))
    .images.filter((m) => m.split === "test")
    .map((m) => ({ set: "heldout", path: join(here, "predictor/images", m.file), file: m.file }));
  const items = [...bench, ...held];
  const out = join(here, "results/jpegli-compare.jsonl");
  await writeFile(out, "");
  const tmp = await mkdtemp(join(tmpdir(), "optiq-jpegli-"));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, availableParallelism() - 1) }, (_, i) =>
      new Promise((resolve, reject) => {
        const w = new Worker(fileURLToPath(import.meta.url), { workerData: { tmp: join(tmp, String(i)), cjpegli: process.env.CJPEGLI } });
        const feed = () => (next < items.length ? w.postMessage(items[next++]) : (w.terminate(), resolve()));
        w.on("message", async (rows) => {
          if (rows.length) await appendFile(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
          feed();
        });
        w.on("error", reject);
        feed();
      }),
    ),
  );
  await rm(tmp, { recursive: true, force: true });

  // Summary: bytes(jpegli) / bytes(mozjpeg) at equal SSIMULACRA2.
  const rows = (await readFile(out, "utf8")).trim().split("\n").map((l) => JSON.parse(l)).filter((r) => !r.error);
  const curves = new Map();
  for (const r of rows) {
    const k = `${r.set}|${r.file}|${r.encoder}`;
    (curves.get(k) ?? curves.set(k, []).get(k)).push(r);
  }
  // Bytes needed for SSIMULACRA2 ≥ t: first grid point at or above t, interpolated (curves are near-monotonic).
  const bytesAt = (pts, t) => {
    const p = [...pts].sort((a, b) => a.q - b.q);
    const i = p.findIndex((x) => x.s2 >= t);
    if (i < 0) return null;
    if (i === 0) return p[0].bytes;
    const a = p[i - 1], b = p[i];
    return a.bytes + ((t - a.s2) / (b.s2 - a.s2)) * (b.bytes - a.bytes);
  };
  const pct = (a, q) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))];
  console.log("bytes(jpegli) / bytes(MozJPEG) at the same SSIMULACRA2 (median, p10..p90, jpegli smaller on)");
  for (const set of ["bench", "heldout"]) {
    for (const group of ["photo", "graphic", "all"]) {
      const line = [];
      for (const t of TARGETS) {
        const ratios = [];
        for (const [k, pts] of curves) {
          const [s, file, enc] = k.split("|");
          if (s !== set || enc !== "mozjpeg") continue;
          const isPhoto = pts[0].category === "photo";
          if (group !== "all" && (group === "photo") !== isPhoto) continue;
          const j = curves.get(`${s}|${file}|jpegli`);
          const bm = bytesAt(pts, t), bj = j && bytesAt(j, t);
          if (bm && bj) ratios.push(bj / bm);
        }
        if (ratios.length) line.push(`s2 ${t}: ${pct(ratios, 0.5).toFixed(2)} (${pct(ratios, 0.1).toFixed(2)}..${pct(ratios, 0.9).toFixed(2)}, ${Math.round((100 * ratios.filter((r) => r < 1).length) / ratios.length)}%, n=${ratios.length})`);
      }
      console.log(`${set.padEnd(8)} ${group.padEnd(8)} ${line.join("  ")}`);
    }
  }
} else {
  const { tmp, cjpegli } = workerData;
  await mkdir(tmp, { recursive: true });
  const sharp = (await import("sharp")).default;
  const { decodeOriented, decoder } = await import(join(here, "common.mjs"));
  const { classify } = await import(join(here, "../dist/classify.js"));
  const { hasTransparentPixels } = await import(join(here, "../dist/pixels.js"));
  const run = promisify(execFile);
  const backend = await decoder();
  const toPng = (img, path) =>
    sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), { raw: { width: img.width, height: img.height, channels: 4 } })
      .removeAlpha()
      .png({ compressionLevel: 1 })
      .toFile(path);

  parentPort.on("message", async (item) => {
    const rows = [];
    try {
      const ref = (await decodeOriented(new Uint8Array(await readFile(item.path)))).img;
      if (ref.width * ref.height <= 4_000_000 && !hasTransparentPixels(ref)) {
        const { category } = classify(ref);
        const chroma = category === "photo" || category === "gradient" ? "420" : "444";
        const refPng = join(tmp, "ref.png"), outPng = join(tmp, "out.png"), jpg = join(tmp, "out.jpg");
        await toPng(ref, refPng);
        const score = async (bytes) => {
          await toPng(await backend.decode("jpeg", bytes), outPng);
          return Number((await run("ssimulacra2", [refPng, outPng])).stdout.trim());
        };
        for (const q of GRID) {
          const moz = await backend.encode("jpeg", ref, { quality: q, chroma });
          rows.push({ set: item.set, file: item.file, category, chroma, encoder: "mozjpeg", q, bytes: moz.length, s2: await score(moz) });
          await run(cjpegli, [refPng, jpg, "-q", String(q), `--chroma_subsampling=${chroma}`]);
          const jl = new Uint8Array(await readFile(jpg));
          rows.push({ set: item.set, file: item.file, category, chroma, encoder: "jpegli", q, bytes: jl.length, s2: await score(jl) });
        }
      }
    } catch (e) {
      rows.push({ set: item.set, file: item.file, error: String(e) });
    }
    parentPort.postMessage(rows);
  });
}
