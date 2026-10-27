// Generates the Optiq aperture mark (8 blades) as SVG, plus PNG favicons, and copies them into docs/ and demo/.
// Geometry: an inner regular octagon; each blade edge is a side of the octagon extended to the outer circle.
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = fileURLToPath(new URL("..", import.meta.url));
const C = 32, R = 30, BLADES = 8;
const f = (n) => +n.toFixed(2);

function mark({ inner, gap, rotate }) {
  const v = Array.from({ length: BLADES }, (_, i) => {
    const a = ((i * 360) / BLADES + rotate) * (Math.PI / 180);
    return [C + inner * Math.cos(a), C + inner * Math.sin(a)];
  });
  const lines = v.map(([x0, y0], i) => {
    const [x1, y1] = v[(i + 1) % BLADES];
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len;
    // Intersection of the ray (x0,y0)+t*u with the circle, t > 0.
    const px = x0 - C, py = y0 - C;
    const b = px * ux + py * uy;
    const t = -b + Math.sqrt(b * b - (px * px + py * py - (R + 1) * (R + 1)));
    return `M${f(x0)} ${f(y0)}L${f(x0 + ux * t)} ${f(y0 + uy * t)}`;
  });
  return { hole: v.map(([x, y]) => `${f(x)},${f(y)}`).join(" "), lines: lines.join(""), gap };
}

function svg({ hole, lines, gap }, fill, extraStyle = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Optiq">${extraStyle}<mask id="m"><circle cx="${C}" cy="${C}" r="${R}" fill="#fff"/><polygon points="${hole}" fill="#000"/><path d="${lines}" stroke="#000" stroke-width="${gap}" stroke-linecap="butt"/></mask><rect class="mark" width="64" height="64" fill="${fill}" mask="url(#m)"/></svg>\n`;
}

const logo = mark({ inner: 11, gap: 1.3, rotate: 8 });
const fav = mark({ inner: 12.5, gap: 2.6, rotate: 8 });
const out = join(root, "brand");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "logo.svg"), svg(logo, "currentColor"));
writeFileSync(join(out, "logo-black.svg"), svg(logo, "#111"));
writeFileSync(join(out, "logo-white.svg"), svg(logo, "#f5f5f5"));
writeFileSync(join(out, "favicon.svg"), svg(fav, "#111", "<style>@media (prefers-color-scheme: dark){.mark{fill:#f5f5f5}}</style>"));
const black = Buffer.from(svg(fav, "#111"));
for (const [name, size] of [["favicon-32.png", 32], ["apple-touch-icon.png", 180], ["logo-512.png", 512]]) {
  // Touch icons get a white plate: iOS fills transparency with black.
  const img = sharp(black, { density: (72 * size) / 64 * 4 }).resize(name === "apple-touch-icon.png" ? Math.round(size * 0.8) : size);
  let buf = await img.png().toBuffer();
  if (name === "apple-touch-icon.png") buf = await sharp({ create: { width: size, height: size, channels: 4, background: "#ffffff" } }).composite([{ input: buf, gravity: "center" }]).png().toBuffer();
  writeFileSync(join(out, name), buf);
}
for (const dest of ["docs/public", "demo/public"]) {
  mkdirSync(join(root, dest), { recursive: true });
  for (const fname of ["logo.svg", "logo-black.svg", "logo-white.svg", "favicon.svg", "favicon-32.png", "apple-touch-icon.png"]) copyFileSync(join(out, fname), join(root, dest, fname));
}
console.log("brand assets written to brand/, docs/public/, demo/public/");
