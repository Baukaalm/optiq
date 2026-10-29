// Calibration data: how SSIM (what Optiq gates on) relates to SSIMULACRA2 (independent, perception-tuned) per codec.
// For every image and every lossy codec plan the engine would try in `balanced`, encode on a quality grid and record
// bytes, SSIM and SSIMULACRA2. Used to choose per-codec SSIM thresholds (see bench/calibrate-s2-fit.mjs).
// Images: the 24-image benchmark corpus (fit) and the predictor corpus' held-out split (validation), ≤ 4 MP.
// Needs `pnpm build` and the libjxl `ssimulacra2` tool (`brew install jpeg-xl`).
// Usage: node bench/calibrate-s2.mjs   → bench/results/calibrate-s2.jsonl
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const here = fileURLToPath(new URL(".", import.meta.url));
const GRID = { jpeg: [50, 60, 65, 70, 75, 80, 85, 88, 91, 94, 97], webp: [50, 60, 65, 70, 75, 80, 85, 88, 91, 94, 97], avif: [30, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90] };
const MAX_PIXELS = 4_000_000;

if (isMainThread) {
  const bench = JSON.parse(await readFile(join(here, "corpus/manifest.json"), "utf8")).images.map((m) => ({ set: "bench", path: join(here, "corpus/images", m.file), file: m.file }));
  const held = JSON.parse(await readFile(join(here, "predictor/manifest.json"), "utf8"))
    .images.filter((m) => m.split === "test")
    .map((m) => ({ set: "heldout", path: join(here, "predictor/images", m.file), file: m.file }));
  const items = [...bench, ...held];
  const out = join(here, "results/calibrate-s2.jsonl");
  await writeFile(out, "");
  const tmp = await mkdtemp(join(tmpdir(), "optiq-cal-"));
  let next = 0, done = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: Math.max(1, availableParallelism() - 1) }, (_, i) =>
      new Promise((resolve, reject) => {
        const w = new Worker(fileURLToPath(import.meta.url), { workerData: { here, tmp: join(tmp, String(i)), GRID, MAX_PIXELS } });
        const feed = () => (next < items.length ? w.postMessage(items[next++]) : (w.terminate(), resolve()));
        w.on("message", async (rows) => {
          if (rows.length) await appendFile(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
          if (++done % 10 === 0) console.log(`${done}/${items.length}  ${((performance.now() - t0) / 1000).toFixed(0)} s`);
          feed();
        });
        w.on("error", reject);
        feed();
      }),
    ),
  );
  await rm(tmp, { recursive: true, force: true });
  console.log(`wrote ${out}`);
} else {
  const { here, tmp, GRID, MAX_PIXELS } = workerData;
  const { mkdir } = await import("node:fs/promises");
  await mkdir(tmp, { recursive: true });
  const sharp = (await import("sharp")).default;
  const { decodeOriented, decoder } = await import(join(here, "common.mjs"));
  const dist = join(here, "../dist");
  const { classify } = await import(join(dist, "classify.js"));
  const { planCandidates } = await import(join(dist, "plan.js"));
  const { resolveOptions } = await import(join(dist, "options.js"));
  const { ssim } = await import(join(dist, "quality.js"));
  const { hasTransparentPixels } = await import(join(dist, "pixels.js"));
  const run = promisify(execFile);
  const backend = await decoder();
  const opts = resolveOptions({ mode: "balanced" });

  const flatten = (img, bg, path) => {
    const o = Buffer.alloc(img.width * img.height * 3);
    for (let i = 0, j = 0; i < img.data.length; i += 4, j += 3) {
      const a = img.data[i + 3] / 255;
      for (let c = 0; c < 3; c++) o[j + c] = Math.round(img.data[i + c] * a + bg * (1 - a));
    }
    return sharp(o, { raw: { width: img.width, height: img.height, channels: 3 } }).png({ compressionLevel: 1 }).toFile(path);
  };

  parentPort.on("message", async (item) => {
    const rows = [];
    try {
      const ref = (await decodeOriented(new Uint8Array(await readFile(item.path)))).img;
      if (ref.width * ref.height <= MAX_PIXELS) {
        const { category } = classify(ref);
        const transparent = hasTransparentPixels(ref);
        const bgs = transparent ? [255, 0] : [255];
        const refPaths = bgs.map((bg) => join(tmp, `ref-${bg}.png`));
        await Promise.all(bgs.map((bg, k) => flatten(ref, bg, refPaths[k])));
        const plans = planCandidates({ category, allowed: ["jpeg", "webp", "avif"], transparent, pngContainerEligible: false, pixelsExact: true, inputLossy: true }, opts).filter((p) => p.kind === "search");
        for (const plan of plans) {
          for (const q of GRID[plan.format]) {
            const enc = await backend.encode(plan.format, ref, { ...plan.settings, quality: q });
            const out = await backend.decode(plan.format, enc);
            const s = ssim(ref, out).ssim;
            const scores = [];
            for (let k = 0; k < bgs.length; k++) {
              const p = join(tmp, `out-${bgs[k]}.png`);
              await flatten(out, bgs[k], p);
              scores.push(Number((await run("ssimulacra2", [refPaths[k], p])).stdout.trim()));
            }
            rows.push({ set: item.set, file: item.file, category, transparent, format: plan.format, q, bytes: enc.length, ssim: s, s2: Math.min(...scores) });
          }
        }
      }
    } catch (e) {
      rows.push({ set: item.set, file: item.file, error: String(e) });
    }
    parentPort.postMessage(rows);
  });
}
