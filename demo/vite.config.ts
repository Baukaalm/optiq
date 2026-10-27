import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

/**
 * Stand-in for "your existing backend" + S3, for local demos only:
 *   POST /api/presign  -> { url, method, key }   (a real backend calls getSignedUrl(PutObjectCommand) here)
 *   PUT  /mock-s3/:key -> stores bytes in memory; rejects a Content-Type that differs from the presigned one
 *   GET  /mock-s3/:key -> returns the stored object
 * No AWS credentials exist in the browser; the browser only ever sees the short-lived URL.
 */
function mockS3(): Plugin {
  const signed = new Map<string, string>();
  const objects = new Map<string, { type: string; body: Buffer }>();
  return {
    name: "mock-presigned-s3",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };

  async function handler(req: IncomingMessage, res: ServerResponse, next: () => void) {
    {
      {
        const url = new URL(req.url ?? "/", "http://localhost");
        const body = async () => {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          return Buffer.concat(chunks);
        };
        if (req.method === "POST" && url.pathname === "/api/presign") {
          const { fileName, contentType, size } = JSON.parse((await body()).toString());
          if (!/^image\/(jpeg|png|webp|avif|gif|svg\+xml)$/.test(contentType) || size > 50 * 1024 * 1024) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ error: "type or size not allowed" }));
          }
          const key = `uploads/${randomUUID()}-${String(fileName).replace(/[^\w.-]/g, "_")}`;
          signed.set(key, contentType);
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ url: `/mock-s3/${key}?X-Amz-Signature=demo`, method: "PUT", key }));
        }
        if (url.pathname.startsWith("/mock-s3/")) {
          const key = decodeURIComponent(url.pathname.slice("/mock-s3/".length));
          if (req.method === "PUT") {
            const expected = signed.get(key);
            if (!expected || req.headers["content-type"] !== expected) {
              res.statusCode = 403;
              return res.end("SignatureDoesNotMatch: Content-Type differs from the presigned request");
            }
            const b = await body();
            objects.set(key, { type: expected, body: b });
            res.setHeader("etag", `"${createHash("md5").update(b).digest("hex")}"`);
            return res.end();
          }
          const o = objects.get(key);
          if (!o) {
            res.statusCode = 404;
            return res.end();
          }
          res.setHeader("content-type", o.type);
          return res.end(o.body);
        }
        next();
      }
    }
  }
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // GitHub Pages serves the demo under /<repo>/demo/; set DEMO_BASE for that build.
  base: process.env.DEMO_BASE ?? "/",
  plugins: [react(), tailwindcss(), mockS3()],
  // Workers must be ES modules: codecs are loaded with dynamic import().
  worker: { format: "es" },
  // Dev only: pre-bundling would break jSquash's `new URL("x.wasm", import.meta.url)` lookups.
  optimizeDeps: {
    exclude: ["smartcompress", "@jsquash/jpeg", "@jsquash/png", "@jsquash/webp", "@jsquash/avif", "@jsquash/oxipng", "@jsquash/resize"],
  },
  // React + HeroUI + react-aria are ~600 KB minified (186 KB gzip); expected for a demo app.
  build: { target: "es2022", chunkSizeWarningLimit: 800 },
});
