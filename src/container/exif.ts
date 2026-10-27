// Minimal TIFF/EXIF handling: read and patch the Orientation tag (0x0112) in IFD0,
// and build a tiny EXIF block that carries only an orientation.

const ORIENTATION_TAG = 0x0112;

function reader(tiff: Uint8Array) {
  if (tiff.length < 8) return undefined;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!le && !be) return undefined;
  const u16 = (o: number) => (le ? tiff[o] | (tiff[o + 1] << 8) : (tiff[o] << 8) | tiff[o + 1]);
  const u32 = (o: number) =>
    (le
      ? tiff[o] | (tiff[o + 1] << 8) | (tiff[o + 2] << 16) | (tiff[o + 3] << 24)
      : (tiff[o] << 24) | (tiff[o + 1] << 16) | (tiff[o + 2] << 8) | tiff[o + 3]) >>> 0;
  if (u16(2) !== 42) return undefined;
  return { le, u16, u32 };
}

/** Offset of the Orientation entry's value inside `tiff`, or -1. */
function orientationValueOffset(tiff: Uint8Array): number {
  const r = reader(tiff);
  if (!r) return -1;
  const ifd = r.u32(4);
  if (ifd + 2 > tiff.length) return -1;
  const n = r.u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > tiff.length) return -1;
    if (r.u16(e) === ORIENTATION_TAG && r.u16(e + 2) === 3) return e + 8;
  }
  return -1;
}

/** EXIF orientation 1..8; 1 when absent or invalid. */
export function readOrientation(tiff: Uint8Array | undefined): number {
  if (!tiff) return 1;
  const r = reader(tiff);
  const off = orientationValueOffset(tiff);
  if (!r || off < 0) return 1;
  const v = r.u16(off);
  return v >= 1 && v <= 8 ? v : 1;
}

/** Copy of `tiff` with the orientation tag set to `value` (no-op copy if the tag is absent). */
export function withOrientation(tiff: Uint8Array, value: number): Uint8Array {
  const out = tiff.slice();
  const r = reader(out);
  const off = orientationValueOffset(out);
  if (!r || off < 0) return out;
  if (r.le) {
    out[off] = value & 0xff;
    out[off + 1] = 0;
  } else {
    out[off] = 0;
    out[off + 1] = value & 0xff;
  }
  return out;
}

/** Big-endian TIFF with a single IFD0 entry: Orientation. 26 bytes. */
export function buildOrientationExif(orientation: number): Uint8Array {
  return new Uint8Array([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // header, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation & 0xff, 0x00, 0x00, // Orientation SHORT 1
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
}
