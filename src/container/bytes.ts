export const u16be = (b: Uint8Array, o: number): number => (b[o] << 8) | b[o + 1];
export const u32be = (b: Uint8Array, o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
export const u16le = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);
export const u24le = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
export const u32le = (b: Uint8Array, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function ascii(b: Uint8Array, o: number, len: number): string {
  let s = "";
  for (let i = 0; i < len && o + i < b.length; i++) s += String.fromCharCode(b[o + i]);
  return s;
}

export function startsWith(b: Uint8Array, prefix: ArrayLike<number> | string, offset = 0): boolean {
  const p = typeof prefix === "string" ? Array.from(prefix, (c) => c.charCodeAt(0)) : prefix;
  if (b.length < offset + p.length) return false;
  for (let i = 0; i < p.length; i++) if (b[offset + i] !== p[i]) return false;
  return true;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function be16(v: number): Uint8Array {
  return new Uint8Array([(v >>> 8) & 0xff, v & 0xff]);
}
export function be32(v: number): Uint8Array {
  return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}
export function le32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}
export function le24(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff]);
}
export function asciiBytes(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

let crcTable: Uint32Array | undefined;
export function crc32(parts: Uint8Array[]): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) crc = crcTable[(crc ^ p[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** zlib (RFC 1950) via the platform's Compression Streams API (browsers, Node >= 18). */
export async function zlibInflate(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Inflated data exceeds limit");
    }
    chunks.push(value);
  }
  return concat(chunks);
}

export async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  const buf = await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer();
  return new Uint8Array(buf);
}
