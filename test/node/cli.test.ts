import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const cli = join(process.cwd(), "dist/cli.js");
const samples = join(process.cwd(), "demo/public/samples");

async function fixtureDir() {
  const dir = await mkdtemp(join(tmpdir(), "optiq-cli-"));
  await mkdir(join(dir, "in/nested"), { recursive: true });
  await cp(join(samples, "parrots.jpg"), join(dir, "in/parrots.jpg"));
  await cp(join(samples, "app-icon.png"), join(dir, "in/nested/app-icon.png"));
  await cp(join(samples, "code-screenshot.png"), join(dir, "in/code-screenshot.png"));
  return dir;
}

describe("optiq-image CLI", () => {
  it("dry run reports and writes nothing", async () => {
    const dir = await fixtureDir();
    const { stdout } = await run("node", [cli, join(dir, "in"), "--json", "--mode", "fast"]);
    const report = JSON.parse(stdout);
    expect(report.files).toHaveLength(3);
    expect(report.totals.after).toBeLessThan(report.totals.before);
    expect(report.files.every((f: { written?: string }) => !f.written)).toBe(true);
    expect((await readdir(join(dir, "in"))).sort()).toEqual(["code-screenshot.png", "nested", "parrots.jpg"]);
  });

  it("--out mirrors folders, uses the new extension, and outputs decode", async () => {
    const dir = await fixtureDir();
    const { stdout } = await run("node", [cli, join(dir, "in"), "--out", join(dir, "out"), "--json"]);
    const report = JSON.parse(stdout);
    for (const f of report.files) {
      expect(f.written).toBeTruthy();
      const written = join(process.cwd(), f.written);
      expect(written.endsWith(`.${f.to === "jpeg" ? "jpg" : f.to}`)).toBe(true);
      const m = await sharp(await readFile(written)).metadata();
      expect(m.width).toBeGreaterThan(0);
    }
    expect(report.files.some((f: { written: string }) => f.written.includes("/nested/"))).toBe(true);
  });

  it("--in-place keeps names and formats and never grows a file", async () => {
    const dir = await fixtureDir();
    const before = (await stat(join(dir, "in/parrots.jpg"))).size;
    const { stdout } = await run("node", [cli, join(dir, "in"), "--in-place", "--json"]);
    const report = JSON.parse(stdout);
    for (const f of report.files) {
      expect(f.from).toBe(f.to);
      expect(f.after).toBeLessThanOrEqual(f.before);
    }
    expect((await stat(join(dir, "in/parrots.jpg"))).size).toBeLessThanOrEqual(before);
    expect((await readdir(join(dir, "in"))).sort()).toEqual(["code-screenshot.png", "nested", "parrots.jpg"]);
  });

  it("exits non-zero with a clear message for bad arguments and reports per-file errors", async () => {
    await expect(run("node", [cli])).rejects.toMatchObject({ code: 1 });
    const dir = await fixtureDir();
    await cp(join(samples, "parrots.jpg"), join(dir, "in/broken.png"));
    const truncated = (await readFile(join(samples, "app-icon.png"))).subarray(0, 100);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "in/truncated.png"), truncated);
    const err = await run("node", [cli, join(dir, "in"), "--json"]).catch((e) => e);
    expect(err.code).toBe(2);
    const report = JSON.parse(err.stdout);
    expect(report.files.find((f: { file: string }) => f.file.endsWith("truncated.png")).error).toMatch(/MALFORMED_INPUT/);
    // A JPEG with a .png extension is still processed (format comes from content).
    expect(report.files.find((f: { file: string }) => f.file.endsWith("broken.png")).from).toBe("jpeg");
  });
});
