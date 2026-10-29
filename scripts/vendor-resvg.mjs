// Copies resvg's .wasm next to the build so browsers can load it with new URL("../vendor/resvg/index_bg.wasm",
// import.meta.url) — bundlers resolve relative URLs, not package paths. Source: the exact @resvg/resvg-wasm version
// pinned in package.json (MPL-2.0; the file is redistributed unmodified).
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
await mkdir(new URL("../vendor/resvg/", import.meta.url), { recursive: true });
await copyFile(require.resolve("@resvg/resvg-wasm/index_bg.wasm"), new URL("../vendor/resvg/index_bg.wasm", import.meta.url));
