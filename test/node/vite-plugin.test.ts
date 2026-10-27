import { cp, mkdir, mkdtemp, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { build } from "vite";
import { describe, expect, it } from "vitest";

describe("optiq-image/vite", () => {
  it("optimises bundled and public images in place, keeping names, formats and references", async () => {
    const { optiq } = await import(join(process.cwd(), "dist/vite.js"));
    const root = await realpath(await mkdtemp(join(tmpdir(), "optiq-vite-"))); // macOS: /var -> /private/var
    const samples = join(process.cwd(), "demo/public/samples");
    await mkdir(join(root, "public/img"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await cp(join(samples, "parrots.jpg"), join(root, "src/hero.jpg"));
    await cp(join(samples, "code-screenshot.png"), join(root, "public/img/shot.png"));
    await writeFile(join(root, "index.html"), `<!doctype html><img src="/img/shot.png"><script type="module" src="/src/main.js"></script>`);
    await writeFile(join(root, "src/main.js"), `import hero from "./hero.jpg"; document.body.append(Object.assign(new Image(), { src: hero }));`);
    const originalPng = (await stat(join(root, "public/img/shot.png"))).size;
    await build({ root, configFile: false, logLevel: "silent", plugins: [optiq({ verbose: false })], build: { assetsInlineLimit: 0 } });
    const assets = await readdir(join(root, "dist/assets"));
    const heroFile = assets.find((f) => f.startsWith("hero") && f.endsWith(".jpg"));
    expect(heroFile).toBeTruthy();
    const js = (await readdir(join(root, "dist/assets"))).find((f) => f.endsWith(".js"))!;
    expect(await readFile(join(root, "dist/assets", js), "utf8")).toContain(heroFile);
    // Formats unchanged, files decodable, PNG optimised losslessly (same pixels), never larger.
    expect((await sharp(join(root, "dist/assets", heroFile!)).metadata()).format).toBe("jpeg");
    const shot = join(root, "dist/img/shot.png");
    expect((await sharp(shot).metadata()).format).toBe("png");
    expect((await stat(shot)).size).toBeLessThan(originalPng);
    const a = await sharp(join(root, "public/img/shot.png")).ensureAlpha().raw().toBuffer();
    const b = await sharp(shot).ensureAlpha().raw().toBuffer();
    expect(a.equals(b)).toBe(true);
  }, 120_000);
});
