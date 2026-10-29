// Does jSquash's multi-threaded AVIF encoder (picked automatically when the page is cross-origin isolated) work
// inside Optiq's worker after a Vite build, and how much faster is it? Serves the consumer test app twice — plain,
// and with COOP/COEP headers — and times AVIF jobs: one at a time, then several at once.
// Usage: BROWSER=chromium|firefox|webkit node bench/browser/avif-threads.mjs [width height]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, firefox, webkit } from "playwright";

const root = fileURLToPath(new URL("../../test/browser/", import.meta.url));
const outDir = fileURLToPath(new URL("../../test-results/browser-app", import.meta.url));
await build({ configFile: join(root, "vite.config.ts") });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };
const serve = (isolated) =>
  new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
      try {
        const body = await readFile(join(outDir, path === "/" ? "index.html" : path));
        const headers = { "content-type": TYPES[extname(path)] ?? "text/html" };
        if (isolated) Object.assign(headers, { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" });
        res.writeHead(200, headers).end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });

const [width = 1600, height = 1200] = process.argv.slice(2).map(Number);
const engine = { chromium, firefox, webkit }[process.env.BROWSER ?? "chromium"];
const browser = await engine.launch();
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
for (const isolated of [false, true]) {
  const server = await serve(isolated);
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => typeof window.benchAvif === "function");
  const r = await page.evaluate((o) => window.benchAvif(o), { width, height, runs: 3, parallel: 4 });
  console.log(`${browser.browserType().name()} ${browser.version()} | isolated=${r.crossOriginIsolated} cores=${r.cores} | ${width}x${height} AVIF balanced: median ${Math.round(med(r.single))} ms per image (${r.candidates} encodes, ${r.bytes} B, ${r.codec}); 4 images at once: ${Math.round(r.batch)} ms`);
  if (errors.length) console.log("  errors:", errors.slice(0, 3));
  await page.close();
  server.close();
}
await browser.close();
