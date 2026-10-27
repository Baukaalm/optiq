// The deployed site as GitHub Pages would serve it: docs home -> "Try the demo" -> embedded demo compresses the
// auto-loaded sample; the stand-alone demo URL works; every docs page in the sidebar returns 200.
import { chromium } from "playwright";
import { serveSite } from "../../scripts/serve-site.mjs";

const base = process.env.SITE_BASE ?? "/optiq/";
const server = await serveSite();
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + base);
  await page.getByRole("link", { name: "Try the demo" }).first().click();
  await page.waitForURL(/\/try$/);
  const frame = page.frameLocator("iframe.demo-frame");
  await frame.locator('[data-testid="job"][data-status="done"]').first().waitFor({ timeout: 120_000 });
  console.log("embedded demo on /try:", await frame.locator('[data-testid="stats"]').first().textContent());
  if (await frame.locator("h1").count()) throw new Error("hero should be hidden in embed mode");
  await page.screenshot({ path: "test-results/site-try.png", fullPage: false });
  const demo = await browser.newPage();
  const r = await demo.goto(`${origin}${base}demo/`);
  await demo.waitForSelector('[data-testid="job"][data-status="done"]', { timeout: 120_000 });
  console.log("stand-alone demo:", r.status());
  for (const p of ["guide/getting-started", "guide/modes", "guide/options", "guide/formats", "guide/errors", "guide/bundlers", "guide/s3", "guide/faq", "guide/react", "guide/static", "api/", "api/react", "api/vite", "api/upload", "api/node", "benchmarks", "architecture", "try"]) {
    const res = await fetch(`${origin}${base}${p}`);
    if (res.status !== 200) throw new Error(`${p}: HTTP ${res.status}`);
  }
  console.log("all docs pages: 200");
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("site e2e: PASS");
} catch (e) {
  failed = true;
  console.error("site e2e: FAIL", e);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
