// Builds the GitHub Pages site: VitePress docs at SITE_BASE, the demo app at SITE_BASE/demo/ (static: upload
// simulated in the browser). Output: docs/.vitepress/dist. Requires `pnpm build` first (the demo uses dist/).
import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const base = process.env.SITE_BASE ?? "/smartcompress/";
if (!base.startsWith("/") || !base.endsWith("/")) throw new Error(`SITE_BASE must start and end with "/": ${base}`);
const root = fileURLToPath(new URL("..", import.meta.url));
const run = (args, env) => execFileSync("pnpm", args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });

run(["--filter", "smartcompress-docs", "build"], { SITE_BASE: base });
run(["--filter", "smartcompress-demo", "build"], { DEMO_BASE: `${base}demo/`, VITE_UPLOAD_MODE: "simulated" });
const out = `${root}docs/.vitepress/dist`;
rmSync(`${out}/demo`, { recursive: true, force: true });
cpSync(`${root}demo/dist`, `${out}/demo`, { recursive: true });
console.log(`site ready in docs/.vitepress/dist (base ${base}; demo at ${base}demo/)`);
