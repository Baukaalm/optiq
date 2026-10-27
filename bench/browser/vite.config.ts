import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: { alias: { smartcompress: fileURLToPath(new URL("../../dist/index.js", import.meta.url)) } },
  worker: { format: "es" },
  build: { outDir: fileURLToPath(new URL("../../test-results/bench-app", import.meta.url)), emptyOutDir: true, target: "es2022" },
  logLevel: "warn",
});
