import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Consumer-style build: the page imports "smartcompress" from the built dist/ (as an npm consumer would).
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: { alias: { smartcompress: fileURLToPath(new URL("../../dist/index.js", import.meta.url)) } },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@jsquash/jpeg", "@jsquash/png", "@jsquash/webp", "@jsquash/avif", "@jsquash/oxipng", "@jsquash/resize"] },
  build: { outDir: fileURLToPath(new URL("../../test-results/browser-app", import.meta.url)), emptyOutDir: true, target: "es2022" },
  logLevel: "warn",
});
