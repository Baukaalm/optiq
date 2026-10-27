// Before/after the audit fixes, from measured result files only.
// Usage: node bench/audit/compare.mjs [before.json] [after.json]
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(fileURLToPath(new URL(".", import.meta.url)), "../results");
const [beforeFile = "node-v2-before-audit.json", afterFile = "node.json"] = process.argv.slice(2);
const before = JSON.parse(await readFile(join(dir, beforeFile), "utf8")).results;
const after = JSON.parse(await readFile(join(dir, afterFile), "utf8")).results;
const key = (r) => `${r.image}|${r.tool}`;
const b = new Map(before.map((r) => [key(r), r]));
const tools = [...new Set(after.filter((r) => r.tool.startsWith("sc-")).map((r) => r.tool))];
const lines = [];
const out = (s = "") => (lines.push(s), console.log(s));
out(`| Tool | Images | Bytes before → after | Changed outputs | Time before → after (sum) | Min SSIM before → after |`);
out(`|---|---|---|---|---|---|`);
for (const t of tools) {
  const rows = after.filter((r) => r.tool === t && b.has(key(r)));
  const sum = (xs) => xs.reduce((a, x) => a + x, 0);
  const b0 = sum(rows.map((r) => b.get(key(r)).bytes)), b1 = sum(rows.map((r) => r.bytes));
  const t0 = sum(rows.map((r) => b.get(key(r)).timeMs)), t1 = sum(rows.map((r) => r.timeMs));
  const changed = rows.filter((r) => r.bytes !== b.get(key(r)).bytes);
  const minS = (xs) => Math.min(...xs.filter((x) => x !== null && x !== undefined));
  out(`| \`${t}\` | ${rows.length} | ${(b0 / 1e6).toFixed(3)} → ${(b1 / 1e6).toFixed(3)} MB (${(((b1 - b0) / b0) * 100).toFixed(1)}%) | ${changed.length} | ${(t0 / 1000).toFixed(1)} → ${(t1 / 1000).toFixed(1)} s (${(((t1 - t0) / t0) * 100).toFixed(0)}%) | ${minS(rows.map((r) => b.get(key(r)).ssim)).toFixed(4)} → ${minS(rows.map((r) => r.ssim)).toFixed(4)} |`);
}
out();
out(`Changed outputs:`);
out();
out(`| Image | Tool | Bytes before → after | SSIM before → after | Format before → after |`);
out(`|---|---|---|---|---|`);
for (const r of after.filter((x) => x.tool.startsWith("sc-") && b.has(key(x)))) {
  const o = b.get(key(r));
  if (o.bytes === r.bytes) continue;
  out(`| ${r.image} | ${r.tool} | ${o.bytes} → ${r.bytes} (${(((r.bytes - o.bytes) / o.bytes) * 100).toFixed(1)}%) | ${o.ssim?.toFixed(4)} → ${r.ssim?.toFixed(4)} | ${o.outFormat} → ${r.outFormat} |`);
}
export const markdown = lines.join("\n");
