import { startsWith } from "./container/bytes.js";
import { readOrientation } from "./container/exif.js";
import { probeGif } from "./container/gif.js";
import { parseIcc, type IccInfo } from "./container/icc.js";
import { probeIsobmff, sniffIsobmff } from "./container/isobmff.js";
import { probeJpeg } from "./container/jpeg.js";
import { inflateIcc, PNG_SIGNATURE, probePng } from "./container/png.js";
import { isWebp, probeWebp } from "./container/webp.js";
import { OptiqError } from "./errors.js";
import type { DetectedFormat } from "./types.js";

export interface ProbeInfo {
  format: DetectedFormat;
  /** Stored dimensions (before EXIF orientation). */
  width: number;
  height: number;
  /** Format declares an alpha channel / transparency (pixels may still all be opaque). */
  hasAlpha: boolean;
  animated: boolean;
  bitDepth: number;
  /** EXIF orientation 1..8. */
  orientation: number;
  exif?: Uint8Array;
  xmp?: Uint8Array;
  icc?: Uint8Array;
  iccInfo?: IccInfo;
  /** A lossy Optiq output (JPEG COM / WebP chunk marker): re-encoding it again would compound the loss. */
  optiqMarked?: boolean;
  /** Set when pixels cannot be faithfully decoded and re-encoded; only container-level operations are allowed. */
  reencodeBlocker?: string;
  warnings: string[];
}

// The DOCTYPE may carry an internal subset with entity declarations (Illustrator exports do): <!DOCTYPE svg ... [ ... ]>.
const SVG_RE = /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE\s+svg[^>[]*(\[[\s\S]*?\]\s*)?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i;
/** Bytes searched for the root <svg> element; entity declarations in the DOCTYPE can be long. */
const SVG_HEAD = 256 * 1024;

/** Identify the format from content only. Extensions and MIME types are never consulted. */
export function sniffFormat(b: Uint8Array): DetectedFormat | undefined {
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(b, PNG_SIGNATURE)) return "png";
  if (startsWith(b, "GIF87a") || startsWith(b, "GIF89a")) return "gif";
  if (isWebp(b)) return "webp";
  const iso = sniffIsobmff(b);
  if (iso) return iso;
  let head = new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(0, b[0] === 0x3c || b[0] === 0xef || b[0] <= 0x20 ? SVG_HEAD : 4096));
  if (head.charCodeAt(0) === 0xfeff) head = head.slice(1);
  if (SVG_RE.test(head)) return "svg";
  return undefined;
}

function malformed(format: string, e: unknown): OptiqError {
  return new OptiqError("MALFORMED_INPUT", `Malformed ${format.toUpperCase()}: ${e instanceof Error ? e.message : String(e)}`);
}

export async function probe(b: Uint8Array): Promise<ProbeInfo> {
  const format = sniffFormat(b);
  if (!format) throw new OptiqError("UNSUPPORTED_FORMAT", "Unrecognized image format (checked file content, not extension or MIME type)");
  const base = { format, hasAlpha: false, animated: false, bitDepth: 8, orientation: 1, warnings: [] as string[] };
  let info: ProbeInfo;
  try {
    switch (format) {
      case "jpeg": {
        const j = probeJpeg(b);
        info = { ...base, width: j.width, height: j.height, bitDepth: j.precision, exif: j.exif, xmp: j.xmp, icc: j.icc, orientation: readOrientation(j.exif), optiqMarked: j.optiqMarked };
        if (j.components === 4) info.reencodeBlocker = "CMYK/YCCK JPEG cannot be converted to RGB faithfully in the browser";
        else if (j.precision !== 8) info.reencodeBlocker = `${j.precision}-bit JPEG is not supported by the decoder`;
        break;
      }
      case "png": {
        const p = probePng(b);
        info = { ...base, width: p.width, height: p.height, bitDepth: p.bitDepth, hasAlpha: p.hasAlpha, animated: p.animated, exif: p.exif, xmp: p.xmp, orientation: readOrientation(p.exif) };
        if (p.iccCompressed) {
          try {
            info.icc = await inflateIcc(p.iccCompressed);
          } catch {
            info.warnings.push("Embedded ICC profile could not be decompressed");
            info.reencodeBlocker = "Unreadable embedded ICC profile";
          }
        }
        if (p.hasGamaOrChrm && !p.iccCompressed && !p.hasSrgbChunk) {
          info.warnings.push("PNG gAMA/cHRM colour chunks are only preserved in PNG output");
        }
        break;
      }
      case "webp": {
        const w = probeWebp(b);
        info = { ...base, width: w.width, height: w.height, hasAlpha: w.hasAlpha, animated: w.animated, exif: w.exif, xmp: w.xmp, icc: w.icc, orientation: readOrientation(w.exif), optiqMarked: w.optiqMarked };
        break;
      }
      case "gif": {
        const g = probeGif(b);
        info = { ...base, width: g.width, height: g.height, hasAlpha: g.hasTransparency, animated: g.animated };
        break;
      }
      case "heif":
        // Recognized only to give an actionable error; never decoded.
        return { ...base, width: 0, height: 0 };
      case "avif": {
        const h = probeIsobmff(b);
        if (!h.width || !h.height) throw new Error("no image extent (ispe) found");
        info = { ...base, width: h.width, height: h.height, hasAlpha: h.hasAlpha, animated: h.animated, bitDepth: h.bitDepth ?? 8, icc: h.icc };
        if (h.hasTransform) info.reencodeBlocker = "AVIF/HEIF rotation or mirror properties (irot/imir) are not applied by the decoder";
        if (h.hasExifItem || h.hasXmpItem) info.warnings.push("Metadata items in AVIF/HEIF are not extracted");
        break;
      }
      case "svg":
        return { ...base, width: 0, height: 0 };
    }
  } catch (e) {
    if (e instanceof OptiqError) throw e;
    throw malformed(format, e);
  }
  if (!info.width || !info.height) throw malformed(format, new Error("zero image dimensions"));
  if (info.icc) {
    info.iccInfo = parseIcc(info.icc);
    if (!info.iccInfo) {
      info.warnings.push("Embedded ICC profile is not a valid ICC profile and was ignored");
      info.icc = undefined;
    } else if (info.iccInfo.colorSpace !== "RGB ") {
      info.reencodeBlocker ??= `ICC profile colour space ${info.iccInfo.colorSpace.trim()} cannot be attached to RGB output`;
    }
  }
  return info;
}

/** Dimensions as displayed, after applying EXIF orientation. */
export function displayDimensions(info: ProbeInfo): { width: number; height: number } {
  return info.orientation >= 5 ? { width: info.height, height: info.width } : { width: info.width, height: info.height };
}
