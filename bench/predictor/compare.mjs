// Real engine runs comparing search starts (fixed / category / model) in balanced and fast mode, on
//  - the predictor's held-out test split, and
//  - the independent 24-image benchmark corpus (different sources: Kodak, other templates) — out-of-distribution.
// Per image all variants run back to back in the same thread, so timings are comparable.
// Usage: node bench/predictor/compare.mjs   (needs both corpora and `pnpm build`)
import { readFile, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const here = fileURLToPath(new URL(".", import.meta.url));
const VARIANTS = ["fixed", "category", "model"];
const MODES = ["balanced", "fast"];

if (isMainThread) {
  const test = JSON.parse(await readFile(join(here, "manifest.json"), "utf8")).images.filter((m) => m.split === "test").map((m) => ({ set: "predictor-test", path: join(here, "images", m.file), file: m.file }));
  const bench = JSON.parse(await readFile(join(here, "../corpus/manifest.json"), "utf8")).images.map((m) => ({ set: "benchmark-24", path: join(here, "../corpus/images", m.file), file: m.file, category: m.category }));
  const items = [...test, ...bench];
  const rows = [];
  let next = 0;
  const n = Math.min(Number(process.env.THREADS ?? Math.max(1, Math.floor(availableParallelism() / 2))), items.length);
  await Promise.all(
    Array.from({ length: n }, () => new Promise((resolve, reject) => {
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: { dist: join(here, "../../dist") } });
      const feed = () => (next < items.length ? w.postMessage(items[next++]) : (w.terminate(), resolve()));
      w.on("message", (r) => {
        rows.push(...r);
        if (rows.length % 60 === 0) console.log(`${rows.length / (VARIANTS.length * MODES.length)}/${items.length}`);
        feed();
      });
      w.on("error", reject);
      feed();
    })),
  );
  await writeFile(join(here, "../results/predictor-compare.json"), JSON.stringify({ date: new Date().toISOString(), rows }, null, 2) + "\n");
  const sum = (a, k) => a.reduce((s, r) => s + r[k], 0);
  const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
  for (const set of ["predictor-test", "benchmark-24"]) {
    for (const mode of MODES) {
      console.log(`\n== ${set} / ${mode}`);
      const base = rows.filter((r) => r.set === set && r.mode === mode && r.variant === "fixed");
      for (const v of VARIANTS) {
        const rs = rows.filter((r) => r.set === set && r.mode === mode && r.variant === v);
        const bytes = sum(rs, "bytes"), b0 = sum(base, "bytes");
        console.log(
          `  ${v.padEnd(9)} encodes ${(sum(rs, "encodes") / rs.length).toFixed(2).padStart(5)}  time sum ${(sum(rs, "ms") / 1000).toFixed(1).padStart(6)} s  median ${median(rs.map((r) => r.ms)).toFixed(0).padStart(5)} ms  ` +
            `bytes ${(bytes / 1e6).toFixed(3)} MB (${(((bytes - b0) / b0) * 100).toFixed(1)}%)  min quality ${Math.min(...rs.map((r) => r.quality)).toFixed(4)}  constraints met ${rs.filter((r) => r.met).length}/${rs.length}`,
        );
      }
    }
  }
} else {
  const { optimizeInNode } = await import(join(workerData.dist, "node.js"));
  parentPort.on("message", async (item) => {
    const input = new Uint8Array(await readFile(item.path));
    const out = [];
    for (const mode of MODES) {
      for (const variant of VARIANTS) {
        const t = performance.now();
        const r = await optimizeInNode(input, { mode, searchStart: variant, preserveMetadata: false });
        out.push({
          set: item.set,
          file: item.file,
          mode,
          variant,
          ms: performance.now() - t,
          bytes: r.report.outputBytes,
          encodes: r.report.candidates.filter((c) => c.codec !== "original" && c.codec !== "container-rewrite").length,
          quality: r.report.qualityMetric ?? 0,
          met: r.report.constraintsMet,
          format: r.report.outputFormat,
          category: r.report.category,
        });
      }
    }
    parentPort.postMessage(out);
  });
}
