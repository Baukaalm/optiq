// Independent quality check of the benchmark outputs with SSIMULACRA2, the reference `ssimulacra2` tool from libjxl
// (Homebrew: `brew install jpeg-xl`). Optiq selects outputs with SSIM, so scoring them with SSIM as well favours it;
// SSIMULACRA2 is a different, perception-tuned metric that Optiq never sees.
// Scale (from the metric's authors): 90 very high (indistinguishable at 1:1), 80 high, 70 medium, 50 low, 30 bad.
// Images with transparency are flattened onto white and onto black and the lower score is kept.
// Inputs: bench/results/raw/{node,browser}/*.out from `pnpm bench:node` / `pnpm bench:browser`. Needs `pnpm build`.
// Usage: node bench/ssimulacra2.mjs   → bench/results/ssimulacra2.json + a summary
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import { decodeOriented } from "./common.mjs";

const run = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const manifest = JSON.parse(await readFile(join(here, "corpus/manifest.json"), "utf8")).images;
const tmp = await mkdtemp(join(tmpdir(), "optiq-s2-"));
const { stdout: toolVersion } = await run("brew", ["list", "--versions", "jpeg-xl"]).catch(() => ({ stdout: "unknown" }));

const png = (img, bg, path) => {
  const out = Buffer.alloc(img.width * img.height * 3);
  for (let i = 0, j = 0; i < img.data.length; i += 4, j += 3) {
    const a = img.data[i + 3] / 255;
    for (let c = 0; c < 3; c++) out[j + c] = Math.round(img.data[i + c] * a + bg * (1 - a));
  }
  return sharp(out, { raw: { width: img.width, height: img.height, channels: 3 } }).png({ compressionLevel: 1 }).toFile(path);
};
const s2 = async (a, b) => Number((await run("ssimulacra2", [a, b])).stdout.trim());

const jobs = [];
for (const env of ["node", "browser"]) {
  const dir = join(here, "results/raw", env);
  for (const f of (await readdir(dir).catch(() => [])).sort()) {
    const img = manifest.find((m) => f.startsWith(m.file + "."));
    if (img) jobs.push({ env, image: img.file, category: img.category, tool: f.slice(img.file.length + 1, -4), path: join(dir, f), originalBytes: img.bytes });
  }
}

const refs = new Map();
const reference = async (file) => {
  if (!refs.has(file)) refs.set(file, decodeOriented(new Uint8Array(await readFile(join(here, "corpus/images", file)))).then((r) => r.img));
  return refs.get(file);
};

const rows = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.max(1, availableParallelism() - 1) }, async (_, w) => {
    while (next < jobs.length) {
      const j = jobs[next++];
      const bytes = new Uint8Array(await readFile(j.path));
      const ref = await reference(j.image);
      const out = (await decodeOriented(bytes)).img;
      const row = { env: j.env, image: j.image, category: j.category, tool: j.tool, bytes: bytes.length, reduction: 1 - bytes.length / j.originalBytes, s2: null };
      if (out.width === ref.width && out.height === ref.height) {
        const alpha = ref.data.some((v, i) => i % 4 === 3 && v < 255) || out.data.some((v, i) => i % 4 === 3 && v < 255);
        const scores = [];
        for (const bg of alpha ? [255, 0] : [255]) {
          const a = join(tmp, `${w}-ref.png`), b = join(tmp, `${w}-out.png`);
          await Promise.all([png(ref, bg, a), png(out, bg, b)]);
          scores.push(await s2(a, b));
        }
        row.s2 = Math.min(...scores);
      } else row.note = `resized to ${out.width}x${out.height}, not scored`;
      rows.push(row);
    }
  }),
);
await rm(tmp, { recursive: true, force: true });
rows.sort((a, b) => (a.env + a.tool + a.image).localeCompare(b.env + b.tool + b.image));
await writeFile(join(here, "results/ssimulacra2.json"), JSON.stringify({ date: new Date().toISOString(), tool: `ssimulacra2 (libjxl, ${toolVersion.trim()})`, rows }, null, 2) + "\n");

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
console.log(`tool: ${toolVersion.trim()}  outputs scored: ${rows.filter((r) => r.s2 !== null).length}/${rows.length}\n`);
console.log("env      tool                     n  total bytes   min s2  median  ≥90  ≥80  ≥70  <50");
for (const key of [...new Set(rows.map((r) => `${r.env}|${r.tool}`))]) {
  const [env, tool] = key.split("|");
  const rs = rows.filter((r) => r.env === env && r.tool === tool && r.s2 !== null);
  const s = rs.map((r) => r.s2);
  const bytes = rs.reduce((t, r) => t + r.bytes, 0);
  const at = (t) => String(s.filter((v) => v >= t).length).padStart(4);
  console.log(
    `${env.padEnd(8)} ${tool.padEnd(22)} ${String(rs.length).padStart(3)}  ${(bytes / 1e6).toFixed(2).padStart(8)} MB  ${Math.min(...s).toFixed(1).padStart(6)}  ${median(s).toFixed(1).padStart(6)} ${at(90)} ${at(80)} ${at(70)} ${String(s.filter((v) => v < 50).length).padStart(4)}`,
  );
}
