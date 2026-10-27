import { ascii, u32be } from "./bytes.js";

export interface IccInfo {
  /** Data colour space signature, e.g. "RGB ", "GRAY", "CMYK". */
  colorSpace: string;
  description: string;
  /** Profile describes sRGB (by description). Dropping it is then visually equivalent in colour-managed browsers. */
  isSrgb: boolean;
}

export function parseIcc(icc: Uint8Array): IccInfo | undefined {
  if (icc.length < 132 || ascii(icc, 36, 4) !== "acsp") return undefined;
  const colorSpace = ascii(icc, 16, 4);
  const count = u32be(icc, 128);
  let description = "";
  for (let i = 0; i < count && 132 + i * 12 + 12 <= icc.length; i++) {
    const e = 132 + i * 12;
    if (ascii(icc, e, 4) !== "desc") continue;
    const off = u32be(icc, e + 4);
    const size = u32be(icc, e + 8);
    if (off + size > icc.length || size < 12) break;
    const type = ascii(icc, off, 4);
    if (type === "desc") {
      const n = u32be(icc, off + 8);
      description = ascii(icc, off + 12, Math.min(n, size - 12)).replace(/\0+$/, "");
    } else if (type === "mluc") {
      const records = u32be(icc, off + 8);
      if (records > 0) {
        const len = u32be(icc, off + 20);
        const strOff = off + u32be(icc, off + 24);
        let s = "";
        for (let j = 0; j + 1 < len && strOff + j + 1 < icc.length; j += 2) s += String.fromCharCode((icc[strOff + j] << 8) | icc[strOff + j + 1]);
        description = s;
      }
    }
    break;
  }
  return { colorSpace, description, isSrgb: colorSpace === "RGB " && /sRGB/i.test(description) };
}
