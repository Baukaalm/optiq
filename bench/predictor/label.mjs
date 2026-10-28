// Ground truth for the quality predictor: for every corpus image and every lossy codec plan the engine would try in
// `balanced` mode, the exact smallest quality (step 1) whose output meets the engine's SSIM threshold, plus image
// features. Runs on worker_threads. Output: bench/predictor/labels.jsonl. Needs `pnpm build`.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const here = fileURLToPath(new URL(".", import.meta.url));
const dist = join(here, "../../dist");

if (isMainThread) {
  const manifest = JSON.parse(await readFile(join(here, "manifest.json"), "utf8")).images;
  const only = process.env.ONLY;
  const items = manifest.filter((m) => !only || m.file.includes(only));
  const outFile = join(here, "labels.jsonl");
  await writeFile(outFile, "");
  const n = Math.min(items.length, Number(process.env.THREADS ?? Math.max(1, availableParallelism() - 1)));
  let next = 0, done = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: n }, () =>
      new Promise((resolve, reject) => {
        const w = new Worker(fileURLToPath(import.meta.url), { workerData: { dist, here } });
        const feed = () => (next < items.length ? w.postMessage(items[next++]) : (w.terminate(), resolve()));
        w.on("message", async (row) => {
          await appendFile(outFile, JSON.stringify(row) + "\n");
          done++;
          if (done % 20 === 0 || done === items.length) console.log(`${done}/${items.length}  ${((performance.now() - t0) / 1000).toFixed(0)} s`);
          feed();
        });
        w.on("error", reject);
        feed();
      }),
    ),
  );
  console.log(`wrote ${outFile}`);
} else {
  const { dist, here } = workerData;
  const { initNodeCodecs, createWasmBackend } = await import(join(dist, "node.js"));
  const { classify } = await import(join(dist, "classify.js"));
  const { planCandidates, effectiveMinQuality } = await import(join(dist, "plan.js"));
  const { resolveOptions } = await import(join(dist, "options.js"));
  const { ssim } = await import(join(dist, "quality.js"));
  const { hasTransparentPixels } = await import(join(dist, "pixels.js"));
  const { extraFeatures } = await import(join(here, "features.mjs"));
  await initNodeCodecs();
  const w = createWasmBackend();
  const opts = resolveOptions({ mode: "balanced" });

  parentPort.on("message", async (item) => {
    const bytes = new Uint8Array(await readFile(join(here, "images", item.file)));
    const img = await w.decode(item.file.endsWith(".png") ? "png" : "jpeg", bytes);
    const { category, features } = classify(img);
    const transparent = hasTransparentPixels(img);
    const threshold = effectiveMinQuality(category, opts);
    const plans = planCandidates({ category, allowed: ["jpeg", "webp", "avif"], transparent, pngContainerEligible: false, pixelsExact: true, inputLossy: item.file.endsWith(".jpg") }, opts).filter((p) => p.kind === "search");
    const cache = new Map();
    const evalAt = async (plan, q) => {
      const key = `${plan.format}:${q}`;
      if (!cache.has(key)) {
        const enc = await w.encode(plan.format, img, { ...plan.settings, quality: q });
        const s = ssim(img, await w.decode(plan.format, enc)).ssim;
        cache.set(key, { q, bytes: enc.length, ssim: s });
      }
      return cache.get(key);
    };
    const results = {};
    for (const plan of plans) {
      const [lo0, hi0] = plan.range;
      let lo = lo0, hi = hi0, best;
      const top = await evalAt(plan, hi0);
      if (top.ssim < threshold) {
        results[plan.format] = { q: null, maxSsim: top.ssim };
        continue;
      }
      best = top;
      hi = hi0 - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = await evalAt(plan, mid);
        if (r.ssim >= threshold) {
          best = r;
          hi = mid - 1;
        } else lo = mid + 1;
      }
      results[plan.format] = { q: best.q, bytes: best.bytes, ssim: best.ssim, start: plan.start, evals: [...cache.keys()].filter((k) => k.startsWith(plan.format)).length };
    }
    parentPort.postMessage({ file: item.file, category: item.category, engineCategory: category, split: item.split, width: img.width, height: img.height, transparent, threshold, features: { ...features, ...extraFeatures(img) }, results });
  });
}
