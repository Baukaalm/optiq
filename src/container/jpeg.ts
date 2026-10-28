import { asciiBytes, be16, concat, startsWith, u16be } from "./bytes.js";

export interface JpegSegment {
  marker: number;
  /** Offset of the 0xFF marker byte. */
  start: number;
  /** Exclusive end of the segment (for SOS: end of the entropy-coded data that follows). */
  end: number;
  /** Payload offset (after the 2-byte length) and length. */
  dataStart: number;
  dataLength: number;
}

export interface JpegContainer {
  segments: JpegSegment[];
  /** Exclusive end of the EOI marker. Bytes after this are trailing data (e.g. MPF images, vendor trailers). */
  eoiEnd: number;
}

const EXIF_ID = asciiBytes("Exif\0\0");
const XMP_ID = asciiBytes("http://ns.adobe.com/xap/1.0/\0");
const ICC_ID = asciiBytes("ICC_PROFILE\0");
const ICC_CHUNK_MAX = 65535 - 2 - ICC_ID.length - 2;
/** COM payload marking a lossy Optiq output, so later runs do not re-encode it (generation loss). */
export const OPTIQ_MARKER = "optiq-image";
const isOptiqMarker = (marker: number, data: Uint8Array) => marker === 0xfe && startsWith(data, OPTIQ_MARKER);

function isStandalone(m: number): boolean {
  return m === 0x01 || (m >= 0xd0 && m <= 0xd8);
}

export function parseJpeg(b: Uint8Array): JpegContainer {
  if (!startsWith(b, [0xff, 0xd8])) throw new Error("Not a JPEG");
  const segments: JpegSegment[] = [];
  let o = 2;
  for (;;) {
    if (o >= b.length) throw new Error("Truncated JPEG: missing EOI");
    if (b[o] !== 0xff) throw new Error(`Invalid JPEG marker at ${o}`);
    const start = o;
    while (o < b.length && b[o] === 0xff) o++; // fill bytes
    const marker = b[o++];
    if (marker === 0xd9) return { segments, eoiEnd: o };
    if (isStandalone(marker)) {
      segments.push({ marker, start, end: o, dataStart: o, dataLength: 0 });
      continue;
    }
    if (o + 2 > b.length) throw new Error("Truncated JPEG segment");
    const len = u16be(b, o);
    if (len < 2 || o + len > b.length) throw new Error("Invalid JPEG segment length");
    const dataStart = o + 2;
    o += len;
    if (marker === 0xda) {
      // Entropy-coded data runs until a marker that is not a stuffed 0x00 or a restart marker.
      while (o < b.length) {
        if (b[o] === 0xff && o + 1 < b.length) {
          const n = b[o + 1];
          if (n !== 0x00 && !(n >= 0xd0 && n <= 0xd7) && n !== 0xff) break;
        }
        o++;
      }
    }
    segments.push({ marker, start, end: o, dataStart, dataLength: len - 2 });
  }
}

export interface JpegInfo {
  width: number;
  height: number;
  components: number;
  precision: number;
  progressive: boolean;
  /** Adobe APP14 transform; with 4 components this means CMYK/YCCK. */
  adobeTransform?: number;
  exif?: Uint8Array;
  xmp?: Uint8Array;
  icc?: Uint8Array;
  hasTrailingData: boolean;
  /** Bytes in APPn/COM segments other than ICC, plus trailing data. */
  strippableBytes: number;
  /** Carries the Optiq COM marker (a lossy Optiq output). */
  optiqMarked: boolean;
}

export function probeJpeg(b: Uint8Array): JpegInfo {
  const { segments, eoiEnd } = parseJpeg(b);
  let sof: JpegSegment | undefined;
  let exif: Uint8Array | undefined;
  let xmp: Uint8Array | undefined;
  let adobeTransform: number | undefined;
  let optiqMarked = false;
  const iccChunks: { seq: number; data: Uint8Array }[] = [];
  let strippable = b.length - eoiEnd;
  for (const s of segments) {
    const data = b.subarray(s.dataStart, s.dataStart + s.dataLength);
    const isSof = s.marker >= 0xc0 && s.marker <= 0xcf && s.marker !== 0xc4 && s.marker !== 0xc8 && s.marker !== 0xcc;
    if (isSof && !sof) sof = s;
    else if (s.marker === 0xe1 && startsWith(data, EXIF_ID)) {
      exif ??= data.subarray(EXIF_ID.length);
      strippable += s.end - s.start;
    } else if (s.marker === 0xe1 && startsWith(data, XMP_ID)) {
      xmp ??= data.subarray(XMP_ID.length);
      strippable += s.end - s.start;
    } else if (s.marker === 0xe2 && startsWith(data, ICC_ID) && data.length > ICC_ID.length + 2) {
      iccChunks.push({ seq: data[ICC_ID.length], data: data.subarray(ICC_ID.length + 2) });
    } else if (s.marker === 0xee && startsWith(data, "Adobe") && data.length >= 12) {
      adobeTransform = data[11];
    } else if (isOptiqMarker(s.marker, data)) {
      optiqMarked = true;
    } else if ((s.marker >= 0xe0 && s.marker <= 0xef) || s.marker === 0xfe) {
      strippable += s.end - s.start;
    }
  }
  if (!sof) throw new Error("JPEG has no SOF segment");
  const d = sof.dataStart;
  if (sof.dataLength < 6) throw new Error("Invalid SOF segment");
  iccChunks.sort((a, c) => a.seq - c.seq);
  return {
    precision: b[d],
    height: u16be(b, d + 1),
    width: u16be(b, d + 3),
    components: b[d + 5],
    progressive: sof.marker === 0xc2 || sof.marker === 0xc6 || sof.marker === 0xca || sof.marker === 0xce,
    adobeTransform,
    exif,
    xmp,
    icc: iccChunks.length ? concat(iccChunks.map((c) => c.data)) : undefined,
    hasTrailingData: eoiEnd < b.length,
    strippableBytes: strippable,
    optiqMarked,
  };
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  if (payload.length + 2 > 0xffff) throw new Error("JPEG segment too large");
  return concat([new Uint8Array([0xff, marker]), be16(payload.length + 2), payload]);
}

export interface JpegMetadata {
  exif?: Uint8Array;
  xmp?: Uint8Array;
  icc?: Uint8Array;
}

export function metadataSegments(meta: JpegMetadata): Uint8Array[] {
  const out: Uint8Array[] = [];
  if (meta.exif && meta.exif.length + EXIF_ID.length + 2 <= 0xffff) out.push(segment(0xe1, concat([EXIF_ID, meta.exif])));
  if (meta.xmp && meta.xmp.length + XMP_ID.length + 2 <= 0xffff) out.push(segment(0xe1, concat([XMP_ID, meta.xmp])));
  if (meta.icc) {
    const n = Math.ceil(meta.icc.length / ICC_CHUNK_MAX);
    if (n > 255) throw new Error("ICC profile too large for JPEG");
    for (let i = 0; i < n; i++) {
      const part = meta.icc.subarray(i * ICC_CHUNK_MAX, (i + 1) * ICC_CHUNK_MAX);
      out.push(segment(0xe2, concat([ICC_ID, new Uint8Array([i + 1, n]), part])));
    }
  }
  return out;
}

/**
 * Rebuild a JPEG without EXIF/XMP/COM/other APPn segments and trailing data, inserting `meta` instead.
 * Image data (DQT/DHT/SOF/SOS/...) and ICC/Adobe segments are copied byte-for-byte, so decoded pixels are unchanged.
 * Pass `keepIcc: false` to drop the original ICC segments (only do this for sRGB profiles).
 */
export function rewriteJpegMetadata(b: Uint8Array, meta: JpegMetadata, keepIcc: boolean): Uint8Array {
  const { segments } = parseJpeg(b);
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  let inserted = false;
  const insert = () => {
    if (!inserted) parts.push(...metadataSegments({ exif: meta.exif, xmp: meta.xmp, icc: keepIcc ? undefined : meta.icc }));
    inserted = true;
  };
  for (const s of segments) {
    const data = b.subarray(s.dataStart, s.dataStart + s.dataLength);
    const isApp = s.marker >= 0xe0 && s.marker <= 0xef;
    if (s.marker === 0xe0 && startsWith(data, "JFIF\0")) {
      parts.push(b.subarray(s.start, s.end));
      continue;
    }
    if (s.marker === 0xe2 && startsWith(data, ICC_ID)) {
      if (keepIcc) parts.push(b.subarray(s.start, s.end));
      continue;
    }
    if (s.marker === 0xee) {
      parts.push(b.subarray(s.start, s.end)); // Adobe: affects colour transform, never strip
      continue;
    }
    if (isOptiqMarker(s.marker, data)) {
      parts.push(b.subarray(s.start, s.end)); // keeps protecting the file from repeated lossy re-encoding
      continue;
    }
    if (isApp || s.marker === 0xfe) continue;
    insert();
    parts.push(b.subarray(s.start, s.end));
  }
  insert();
  parts.push(new Uint8Array([0xff, 0xd9]));
  return concat(parts);
}

/** Insert metadata segments into a freshly encoded JPEG (which carries none besides JFIF). */
export function injectJpegMetadata(encoded: Uint8Array, meta: JpegMetadata): Uint8Array {
  const segs = metadataSegments(meta);
  if (!segs.length) return encoded;
  let at = 2;
  if (encoded[2] === 0xff && encoded[3] === 0xe0) at = 4 + u16be(encoded, 4);
  return concat([encoded.subarray(0, at), ...segs, encoded.subarray(at)]);
}

/** Add the Optiq COM marker after SOI/JFIF. Pixels are unchanged. */
export function markJpeg(b: Uint8Array): Uint8Array {
  let at = 2;
  if (b[2] === 0xff && b[3] === 0xe0) at = 4 + u16be(b, 4);
  return concat([b.subarray(0, at), segment(0xfe, asciiBytes(OPTIQ_MARKER)), b.subarray(at)]);
}
