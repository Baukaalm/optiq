// Builds the consumer page with Vite, serves it (optionally with a CSP that blocks WebAssembly),
// and runs the in-page suite in headless Chromium via Playwright.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, firefox, webkit } from "playwright";

const here = fileURLToPath(new URL(".", import.meta.url));
const outDir = fileURLToPath(new URL("../../test-results/browser-app", import.meta.url));
await build({ configFile: join(here, "vite.config.ts") });

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".css": "text/css" };
function serve(csp, isolated) {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    try {
      const body = await readFile(join(outDir, path === "/" ? "index.html" : path));
      const headers = { "content-type": TYPES[extname(path)] ?? (path === "/" ? "text/html" : "application/octet-stream") };
      if (csp) headers["content-security-policy"] = csp;
      if (isolated) Object.assign(headers, { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" });
      res.writeHead(200, headers).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

// BROWSER=chromium (default) | firefox | webkit (Safari's engine).
const engine = { chromium, firefox, webkit }[process.env.BROWSER ?? "chromium"];
const browser = await engine.launch();
let failed = 0;
const runs = [
  { label: "default", csp: undefined, only: process.env.ONLY },
  // No 'wasm-unsafe-eval': WebAssembly compilation is blocked, so the canvas fallback must kick in and be reported.
  { label: "csp-no-wasm", csp: "default-src 'self'; script-src 'self'; worker-src 'self'", only: "jpeg photo" },
  // Cross-origin isolated: jSquash switches to its multi-threaded AVIF and oxipng builds (threads inside our worker).
  { label: "cross-origin-isolated", isolated: true, only: undefined },
];
for (const run of runs) {
  const server = await serve(run.csp, run.isolated);
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => typeof window.runSuite === "function");
  const results = await page.evaluate((only) => window.runSuite(only), run.only);
  console.log(`\n# ${run.label} (${browser.version()})`);
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n      ${JSON.stringify(r.detail)}`);
  }
  if (run.isolated) {
    const isolated = await page.evaluate(() => self.crossOriginIsolated);
    if (!isolated || !results.length) {
      failed++;
      console.log("FAIL  expected a cross-origin isolated page running the AVIF case");
    } else console.log("PASS  multi-threaded AVIF path (cross-origin isolated)");
  }
  if (run.label === "csp-no-wasm") {
    const fb = results[0]?.detail?.fallbacks ?? [];
    if (!results[0]?.ok || fb.length === 0) {
      failed++;
      console.log("FAIL  expected the canvas fallback to be reported under CSP");
    } else console.log("PASS  canvas fallback reported under CSP");
  }
  if (errors.length) console.log("page errors:", errors);
  await page.close();
  server.close();
}
await browser.close();
console.log(failed ? `\n${failed} browser check(s) failed` : "\nall browser checks passed");
process.exit(failed ? 1 : 0);
