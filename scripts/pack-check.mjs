// Pre-publish check (does NOT publish): pack the tarball, inspect its contents, install it into a fresh Vite
// consumer project, typecheck against the shipped .d.ts, build, and run one compression in Chromium.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const work = join(root, "test-results/pack-check");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });

// npm silently rewrites some package.json fields at publish time; treat that as a failure so it is fixed in the repo.
const publishLog = execFileSync("sh", ["-c", "npm publish --dry-run --ignore-scripts --tag latest 2>&1"], { cwd: root, encoding: "utf8" });
if (/auto-corrected|errors corrected/.test(publishLog)) throw new Error(`npm would rewrite package.json on publish:\n${publishLog}`);
console.log("npm publish --dry-run: manifest needs no corrections");
const out = sh("pnpm", ["pack", "--pack-destination", work], root);
const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
const listing = sh("tar", ["-tzf", tgz], work).trim().split("\n");
const bad = listing.filter((f) => /\/(src|test|bench|demo|docs|scripts)\//.test(f) || f.endsWith(".ts") && !f.endsWith(".d.ts"));
console.log(`tarball ${tgz}: ${listing.length} files`);
for (const req of ["package/LICENSE", "package/NOTICE", "package/README.md", "package/dist/index.js", "package/dist/index.d.ts", "package/dist/worker.js", "package/dist/upload.d.ts"]) {
  if (!listing.includes(req)) throw new Error(`missing ${req}`);
}
if (bad.length) throw new Error(`unexpected files in tarball: ${bad.slice(0, 5).join(", ")}`);
void out;

const app = join(work, "consumer");
mkdirSync(join(app, "src"), { recursive: true });
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }, null, 2));
writeFileSync(join(app, "index.html"), `<!doctype html><html><body><script type="module" src="/src/main.ts"></script></body></html>`);
// The configuration the docs recommend (optimizeDeps.exclude matters for the dev server only).
writeFileSync(
  join(app, "vite.config.ts"),
  `import { defineConfig } from "vite";\nexport default defineConfig({ worker: { format: "es" }, optimizeDeps: { exclude: ["optiq-image", "@jsquash/jpeg", "@jsquash/png", "@jsquash/webp", "@jsquash/avif", "@jsquash/oxipng", "@jsquash/resize"] } });\n`,
);
writeFileSync(join(app, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, lib: ["ES2022", "DOM"], skipLibCheck: false, noEmit: true }, include: ["src"] }, null, 2));
writeFileSync(
  join(app, "src/main.ts"),
  `import { compressImage, type CompressionResult } from "optiq-image";
import { compressAndUpload } from "optiq-image/upload";
void compressAndUpload;
(window as unknown as { run: () => Promise<unknown> }).run = async () => {
  const c = new OffscreenCanvas(640, 400);
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 640, 400);
  g.addColorStop(0, "#123"); g.addColorStop(1, "#fc6");
  ctx.fillStyle = g; ctx.fillRect(0, 0, 640, 400);
  ctx.fillStyle = "#fff"; ctx.font = "32px sans-serif"; ctx.fillText("pack check", 40, 200);
  const r: CompressionResult = await compressImage(await c.convertToBlob({ type: "image/png" }));
  return { format: r.outputFormat, bytes: r.outputBytes, original: r.originalBytes, ok: r.constraintsMet };
};
`,
);
const pkgVersions = JSON.parse(sh("node", ["-p", "JSON.stringify(require('./package.json').devDependencies)"], root));
// VITE_VERSION=8 node scripts/pack-check.mjs checks another Vite major.
const viteVersion = process.env.VITE_VERSION ?? pkgVersions.vite;
sh("npm", ["install", "--no-audit", "--no-fund", join(work, tgz), `vite@${viteVersion}`, `typescript@${pkgVersions.typescript}`], app);
console.log(`consumer uses vite ${JSON.parse(sh("node", ["-p", "JSON.stringify(require('vite/package.json').version)"], app))}`);
sh("npx", ["tsc", "-p", "tsconfig.json"], app);
// The bin from the installed tarball works (Node side: CLI + worker_threads + WASM codecs from node_modules).
const cliReport = JSON.parse(sh("npx", ["optiq-image", join(root, "demo/public/samples"), "--mode", "fast", "--json"], app));
if (cliReport.totals.after >= cliReport.totals.before || cliReport.totals.errors) throw new Error("installed CLI failed");
console.log(`installed CLI: ${cliReport.files.length} files, ${cliReport.totals.before} -> ${cliReport.totals.after} B`);
console.log("consumer typecheck against shipped .d.ts: ok");
sh("npx", ["vite", "build", "--logLevel", "warn"], app);
const { preview, createServer } = await import(join(app, "node_modules/vite/dist/node/index.js"));
const srv = await preview({ root: app, preview: { port: 0, host: "127.0.0.1" }, logLevel: "warn" });
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(srv.resolvedUrls.local[0]);
const result = await page.evaluate(() => window.run());
srv.httpServer.close();
console.log("consumer run in Chromium (production build):", result);
const dev = await createServer({ root: app, server: { port: 0, host: "127.0.0.1" }, logLevel: "warn" });
await dev.listen();
const devPage = await browser.newPage();
await devPage.goto(dev.resolvedUrls.local[0]);
await devPage.waitForFunction(() => typeof window.run === "function");
const devResult = await devPage.evaluate(() => window.run());
await dev.close();
await browser.close();
console.log("consumer run in Chromium (dev server):", devResult);
if (!devResult.ok) throw new Error("dev server compression failed");
if (!result.ok || result.bytes >= result.original) throw new Error("consumer compression failed");
console.log("pack check: PASS (nothing was published)");
