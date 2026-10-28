// End-to-end: launch dist/index.js over stdio with the official MCP client and call both tools.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = fileURLToPath(new URL(".", import.meta.url));
const samples = join(here, "../../demo/public/samples");
let client, dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "optiq-mcp-"));
  await mkdir(join(dir, "img/nested"), { recursive: true });
  await cp(join(samples, "parrots.jpg"), join(dir, "img/parrots.jpg"));
  await cp(join(samples, "code-screenshot.png"), join(dir, "img/nested/code.png"));
  client = new Client({ name: "optiq-mcp-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(here, "../dist/index.js")] }));
});
after(() => client?.close());

test("lists two tools with honest annotations", async () => {
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ["analyze_images", "optimize_images"]);
  assert.equal(byName.analyze_images.annotations.readOnlyHint, true);
  assert.equal(byName.optimize_images.annotations.destructiveHint, true);
  assert.ok(byName.optimize_images.outputSchema);
});

test("analyze_images writes nothing and reports savings", async () => {
  const before = await readFile(join(dir, "img/parrots.jpg"));
  const progress = [];
  const r = await client.callTool({ name: "analyze_images", arguments: { paths: [join(dir, "img")], mode: "fast" } }, { onprogress: (p) => progress.push(p) });
  assert.ok(!r.isError, JSON.stringify(r.content));
  const s = r.structuredContent;
  assert.equal(s.dryRun, true);
  assert.equal(s.totals.files, 2);
  assert.ok(s.totals.after < s.totals.before);
  assert.ok(s.files.every((f) => !f.written && f.from === f.to)); // analysis keeps formats by default
  assert.deepEqual(await readFile(join(dir, "img/parrots.jpg")), before);
  assert.equal(progress.at(-1)?.progress, 2);
  assert.match(r.content[0].text, /Dry run/);
});

test("optimize_images in place is idempotent", async () => {
  const first = await client.callTool({ name: "optimize_images", arguments: { paths: [join(dir, "img")], write: "in-place" } });
  assert.ok(!first.isError, JSON.stringify(first.content));
  assert.ok(first.structuredContent.files.some((f) => f.written));
  const once = await readFile(join(dir, "img/parrots.jpg"));
  const second = await client.callTool({ name: "optimize_images", arguments: { paths: [join(dir, "img")], write: "in-place" } });
  const parrots = second.structuredContent.files.find((f) => f.file.endsWith("parrots.jpg"));
  assert.equal(parrots.usedOriginal, true);
  assert.deepEqual(await readFile(join(dir, "img/parrots.jpg")), once);
});

test("optimize_images to a folder mirrors structure; bad input is a tool error, not a crash", async () => {
  const out = join(dir, "out");
  const r = await client.callTool({ name: "optimize_images", arguments: { paths: [join(dir, "img")], write: "out-dir", outDir: out, reoptimize: true } });
  assert.ok(!r.isError);
  assert.equal((await readdir(join(out, "nested"))).length, 1);
  const missing = await client.callTool({ name: "optimize_images", arguments: { paths: [join(dir, "img")], write: "out-dir" } });
  assert.equal(missing.isError, true);
  const nothing = await client.callTool({ name: "analyze_images", arguments: { paths: [join(dir, "does-not-exist")] } });
  assert.equal(nothing.isError, true);
});
