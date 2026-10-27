// Serves docs/.vitepress/dist under SITE_BASE like GitHub Pages (clean URLs, index.html, 404.html).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const base = process.env.SITE_BASE ?? "/optiq/";
const dist = fileURLToPath(new URL("../docs/.vitepress/dist", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const exists = async (p) => (await stat(p).catch(() => null))?.isFile();

export function serveSite(port = 0) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (!path.startsWith(base)) return res.writeHead(302, { location: base }).end();
    const rel = normalize(path.slice(base.length)).replace(/^(\.\.[/\\])+/, "");
    for (const cand of [rel, `${rel}.html`, join(rel, "index.html")]) {
      const file = join(dist, cand);
      if (cand && (await exists(file))) return res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(await readFile(file));
    }
    if (rel === "" || rel === ".") return res.writeHead(200, { "content-type": "text/html" }).end(await readFile(join(dist, "index.html")));
    res.writeHead(404, { "content-type": "text/html" }).end(await readFile(join(dist, "404.html")));
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await serveSite(Number(process.env.PORT ?? 4173));
  console.log(`http://127.0.0.1:${s.address().port}${base}`);
}
