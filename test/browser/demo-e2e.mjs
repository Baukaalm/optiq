// End-to-end on the demo (Vite dev server with the mock presign/S3 middleware) in Chromium:
// add files -> compress in the worker -> compare/inspect -> presign -> PUT -> read the stored object back.
// Also saves screenshots (light, dark, mobile) to test-results/demo-*.png.
import { fileURLToPath } from "node:url";
import { build, createServer, preview } from "vite";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../../demo", import.meta.url));
const shots = fileURLToPath(new URL("../../test-results", import.meta.url));
// Only files committed to the repo (CI has no benchmark corpus): the demo samples plus a generated 12 MP photo.
const SAMPLE = { "photo-kodim23.jpg": "parrots.jpg", "transparent-icon.png": "app-icon.png", "screenshot-code.png": "code-screenshot.png" };
const img = (f) => fileURLToPath(new URL(`../../demo/public/samples/${SAMPLE[f]}`, import.meta.url));
const bigPhoto = fileURLToPath(new URL("../../test-results/big-photo.jpg", import.meta.url));
{
  const { default: sharp } = await import("sharp");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(fileURLToPath(new URL("../../test-results", import.meta.url)), { recursive: true });
  await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#6a8", noise: { type: "gaussian", mean: 128, sigma: 30 } } }).jpeg({ quality: 92 }).toFile(bigPhoto);
}
const server = await createServer({ configFile: `${root}/vite.config.ts`, root, server: { port: 0, host: "127.0.0.1" }, logLevel: "warn" });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
let failed = false;
try {
  {
    // A first visit shows a finished example without any user action.
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForSelector('[data-testid="job"][data-status="done"]', { timeout: 120_000 });
    console.log("auto-loaded sample:", await page.textContent('[data-testid="job"] [data-testid="stats"]'));
    await page.getByRole("button", { name: /^Screenshot/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="job"][data-status="done"]').length === 2, null, { timeout: 120_000 });
    console.log("sample button: ok");
    // Settings switches must actually change the options: with AVIF off, the photo sample must not become AVIF.
    const avif = page.locator('[data-testid="allow-avif"] [role="switch"]');
    if ((await avif.getAttribute("aria-checked")) !== "true" && !(await avif.isChecked())) throw new Error("AVIF switch should start on");
    await page.locator('[data-testid="allow-avif"]').getByText("Allow AVIF").click();
    if (await avif.isChecked()) throw new Error("clicking the Allow AVIF row did not toggle it");
    await page.locator('[data-testid="keep-metadata"]').getByText("Keep metadata").click();
    if (await page.locator('[data-testid="keep-metadata"] [role="switch"]').isChecked()) throw new Error("Keep metadata did not toggle");
    await page.getByRole("button", { name: /^Photo/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="job"][data-status="done"]').length === 3, null, { timeout: 120_000 });
    const newest = await page.locator('[data-testid="job"]').first().textContent();
    if (/→ AVIF/.test(newest)) throw new Error("AVIF disabled but output is AVIF");
    // Mode select: switch to lossless and check a new sample comes back pixel-exact.
    await page.locator('[data-testid="mode"] button').first().click();
    await page.getByRole("option", { name: "Lossless", exact: true }).click();
    await page.getByRole("button", { name: /^Screenshot/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="job"][data-status="done"]').length === 4, null, { timeout: 120_000 });
    if (!/pixel-exact/.test(await page.locator('[data-testid="job"]').first().textContent())) throw new Error("mode select did not switch to lossless");
    console.log("mode select: lossless -> pixel-exact result");
    console.log("switches: toggle and take effect (AVIF off ->", newest.match(/JPEG → \w+/)?.[0], ")");
    await page.close();
  }
  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url + "?nosample");
    await page.setInputFiles('[data-testid="file-input"]', [img("photo-kodim23.jpg"), img("transparent-icon.png")]);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="job"][data-status="done"]').length === 2, null, { timeout: 120_000 });
    const jobs = await page.$$eval('[data-testid="job"]', (els) => els.map((e) => e.querySelector('[data-testid="stats"]')?.textContent));
    console.log(`[${scheme}] compressed:`, jobs);
    if (scheme === "light") {
      // Open the comparison for the photo, then upload it.
      const photo = page.locator('[data-testid="job"]', { hasText: "parrots" });
      await photo.getByRole("button", { name: /Compare before/ }).click();
      await photo.locator('[data-testid="upload"]').click();
      await photo.locator('[data-testid="uploaded"]').waitFor({ timeout: 60_000 });
      const href = await photo.locator('[data-testid="uploaded-link"]').getAttribute("href");
      const stored = await page.evaluate(async (h) => {
        const r = await fetch(h);
        return { type: r.headers.get("content-type"), size: (await r.arrayBuffer()).byteLength };
      }, href);
      const ext = href.split(".").pop();
      console.log("stored object:", stored, href);
      if (!stored.type.includes(ext === "jpg" ? "jpeg" : ext)) throw new Error(`extension ${ext} does not match ${stored.type}`);
      // Cancellation keeps the original uploadable.
      await page.setInputFiles('[data-testid="file-input"]', bigPhoto);
      const big = page.locator('[data-testid="job"]', { hasText: "big-photo" });
      await big.locator('[data-testid="cancel"]').click();
      await big.and(page.locator('[data-status="cancelled"]')).waitFor();
      if (await big.locator('[data-testid="upload-original"]').isDisabled()) throw new Error("original not uploadable after cancel");
      console.log("cancel: ok, original still uploadable");
    }
    await page.screenshot({ path: `${shots}/demo-${scheme}.png`, fullPage: true });
    if (errors.length) throw new Error(errors.join("\n"));
    await page.close();
  }
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await mobile.goto(url + "?nosample");
  await mobile.setInputFiles('[data-testid="file-input"]', img("screenshot-code.png"));
  await mobile.waitForSelector('[data-testid="job"][data-status="done"]', { timeout: 120_000 });
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await mobile.screenshot({ path: `${shots}/demo-mobile.png`, fullPage: true });
  if (overflow > 0) throw new Error(`horizontal overflow on mobile: ${overflow}px`);
  console.log("mobile: no horizontal overflow");

  // Static build as deployed to GitHub Pages: served under a sub-path, upload simulated in the page.
  const outDir = fileURLToPath(new URL("../../test-results/demo-static", import.meta.url));
  process.env.DEMO_BASE = "/smartcompress/demo/";
  process.env.VITE_UPLOAD_MODE = "simulated";
  await build({ configFile: `${root}/vite.config.ts`, root, logLevel: "warn", build: { outDir, emptyOutDir: true } });
  const prev = await preview({ configFile: `${root}/vite.config.ts`, root, logLevel: "warn", build: { outDir }, preview: { port: 0, host: "127.0.0.1" } });
  const staticPage = await browser.newPage();
  const staticErrors = [];
  staticPage.on("pageerror", (e) => staticErrors.push(e.message));
  await staticPage.goto(prev.resolvedUrls.local[0].replace(/\/$/, "") + "/");
  await staticPage.waitForSelector('[data-testid="job"][data-status="done"]', { timeout: 120_000 });
  await staticPage.locator('[data-testid="upload"]').first().click();
  await staticPage.locator('[data-testid="uploaded"]').first().waitFor({ timeout: 30_000 });
  const note = await staticPage.textContent('[data-testid="uploaded"]');
  if (!/Simulated upload/.test(note)) throw new Error("expected simulated upload in static build");
  if (staticErrors.length) throw new Error(staticErrors.join("\n"));
  console.log("static build under /smartcompress/demo/: sample compressed, simulated upload ok");
  prev.httpServer.close();
  console.log("demo e2e: PASS (screenshots in test-results/)");
} catch (e) {
  failed = true;
  console.error("demo e2e: FAIL", e);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
