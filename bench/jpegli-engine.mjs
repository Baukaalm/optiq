// End-to-end check of the jpegli switch inside the engine (SSIM-gated search), against the previous MozJPEG encoder.
// Same images, targetFormat "jpeg", balanced and visually-lossless; bytes, time, and SSIMULACRA2 of the result.
// Images: opaque benchmark images and the predictor corpus' held-out split (≤ 4 MP). Needs `pnpm build`, `ssimulacra2`.
// Usage: node bench/jpegli-engine.mjs → bench/results/jpegli-engine.json + summary
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const here = fileURLToPath(new URL(".", import.meta.url));
const MODES = ["balanced", "visually-lossless"];

if (isMainThread) {
  const bench = JSON.parse(await readFile(join(here, "corpus/manifest.json"), "utf8")).images.map((m) => ({ set: "bench", path: join(here, "corpus/images", m.file), file: m.file }));
  const held = JSON.parse(await readFile(join(here, "predictor/manifest.json"), "utf8"))
    .images.filter((m) => m.split === "test")
    .map((m) => ({ set: "heldout", path: join(here, "predictor/images", m.file), file: m.file }));
  const items = [...bench, ...held];
  const tmp = await mkdtemp(join(tmpdir(), "optiq-jle-"));
  const rows = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.floor(availableParallelism() / 2)) }, (_, i) =>
      new Promise((resolve, reject) => {
        const w = new Worker(fileURLToPath(import.meta.url), { workerData: { tmp: join(tmp, String(i)) } });
        const feed = () => (next < items.length ? w.postMessage(items[next++]) : (w.terminate(), resolve()));
        w.on("message", (r) => {
          rows.push(...r);
          feed();
        });
        w.on("error", reject);
        feed();
      }),
    ),
  );
  await rm(tmp, { recursive: true, force: true });
  await writeFile(join(here, "results/jpegli-engine.json"), JSON.stringify({ date: new Date().toISOString(), rows }, null, 2) + "\n");
  const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
  for (const set of ["bench", "heldout"]) {
    for (const mode of MODES) {
      for (const group of ["photo", "graphic"]) {
        const sel = (enc) => rows.filter((r) => r.set === set && r.mode === mode && r.encoder === enc && (group === "photo") === (r.category === "photo"));
        const m = sel("mozjpeg"), j = sel("jpegli");
        if (!m.length) continue;
        const bytes = (a) => a.reduce((s, r) => s + r.bytes, 0);
        const ratios = j.map((r) => r.bytes / m.find((x) => x.file === r.file).bytes);
        console.log(
          `${set.padEnd(8)} ${mode.padEnd(18)} ${group.padEnd(8)} n=${String(m.length).padStart(3)}  bytes jpegli/moz total ${(bytes(j) / bytes(m)).toFixed(3)} median ${med(ratios).toFixed(3)}  ` +
            `s2 median moz ${med(m.map((r) => r.s2)).toFixed(1)} jpegli ${med(j.map((r) => r.s2)).toFixed(1)}  time median moz ${Math.round(med(m.map((r) => r.ms)))} ms jpegli ${Math.round(med(j.map((r) => r.ms)))} ms`,
        );
      }
    }
  }
} else {
  const { tmp } = workerData;
  await mkdir(tmp, { recursive: true });
  const sharp = (await import("sharp")).default;
  const dist = join(here, "../dist");
  const { initNodeCodecs, createWasmBackend, optimizeInNode } = await import(join(dist, "node.js"));
  const { decodeOriented } = await import(join(here, "common.mjs"));
  const { hasTransparentPixels } = await import(join(dist, "pixels.js"));
  const { createRequire } = await import("node:module");
  const run = promisify(execFile);
  await initNodeCodecs();
  // The previous encoder: jSquash MozJPEG with the settings the engine used before the switch.
  const mozEnc = await import("@jsquash/jpeg/encode.js");
  const req = createRequire(import.meta.url);
  const mozDir = join(req.resolve("@jsquash/jpeg/package.json"), "..");
  await mozEnc.init(await WebAssembly.compile(await readFile(join(mozDir, "codec/enc/mozjpeg_enc.wasm"))));
  const jpegli = createWasmBackend();
  const mozjpeg = {
    ...jpegli,
    async encode(format, img, s) {
      if (format !== "jpeg") return jpegli.encode(format, img, s);
      const sub444 = s.chroma === "444";
      const d = img.data.byteOffset === 0 && img.data.byteLength === img.data.buffer.byteLength ? img.data : img.data.slice();
      return new Uint8Array(
        await mozEnc.default({ data: d, width: img.width, height: img.height, colorSpace: "srgb" }, { quality: s.quality ?? 75, progressive: true, optimize_coding: true, auto_subsample: !sub444, chroma_subsample: sub444 ? 1 : 2, trellis_multipass: false }),
      );
    },
    codecName: (f, s) => (f === "jpeg" ? "mozjpeg" : jpegli.codecName(f, s)),
  };
  const png = (img, path) =>
    sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), { raw: { width: img.width, height: img.height, channels: 4 } }).removeAlpha().png({ compressionLevel: 1 }).toFile(path);

  parentPort.on("message", async (item) => {
    const rows = [];
    try {
      const input = new Uint8Array(await readFile(item.path));
      const ref = (await decodeOriented(input)).img;
      if (ref.width * ref.height <= 4_000_000 && !hasTransparentPixels(ref)) {
        const refPng = join(tmp, "ref.png"), outPng = join(tmp, "out.png");
        await png(ref, refPng);
        for (const mode of MODES) {
          for (const [encoder, backend] of [["mozjpeg", mozjpeg], ["jpegli", jpegli]]) {
            const t = performance.now();
            const r = await optimizeInNode(input, { mode, targetFormat: "jpeg", preserveMetadata: false }, { backend });
            const ms = performance.now() - t;
            const bytes = r.bytes ?? input;
            await png((await decodeOriented(bytes)).img, outPng);
            const s2 = Number((await run("ssimulacra2", [refPng, outPng])).stdout.trim());
            rows.push({ set: item.set, file: item.file, category: r.report.category, mode, encoder, bytes: bytes.length, ms, ssim: r.report.qualityMetric, s2, codec: r.report.codec, quality: r.report.settings.quality });
          }
        }
      }
    } catch (e) {
      rows.push({ set: item.set, file: item.file, error: String(e) });
    }
    parentPort.postMessage(rows);
  });
}
