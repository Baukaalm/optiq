import type { RawImage } from "../pixels.js";
import type { DecodableFormat, OutputFormat } from "../types.js";
import type { CodecBackend, EncodeSettings } from "./types.js";

export interface FallbackBackend extends CodecBackend {
  /** Fallback events, e.g. "webp encode: wasm unavailable (...), used canvas". */
  readonly fallbacks: string[];
}

/**
 * Try `primary`; when an operation throws, retry it on `secondary` and record it. Once an operation kind
 * (e.g. "avif encode") fails on the primary it is routed to the secondary for the rest of the job.
 * Decode failures that also fail on the secondary are re-thrown from the primary (most likely malformed input).
 */
export function withFallback(primary: CodecBackend, secondary: CodecBackend | undefined): FallbackBackend {
  const fallbacks: string[] = [];
  const broken = new Set<string>();
  async function run<T>(op: string, a: () => Promise<T>, b: (() => Promise<T>) | undefined): Promise<T> {
    if (broken.has(op) && b) return b();
    try {
      return await a();
    } catch (e) {
      if (!b) throw e;
      let r: T;
      try {
        r = await b();
      } catch {
        throw e;
      }
      broken.add(op);
      const reason = e instanceof Error ? e.message : String(e);
      fallbacks.push(`${op}: ${primary.name} failed (${reason.slice(0, 120)}); used ${secondary!.name}`);
      return r;
    }
  }
  const backend: FallbackBackend = {
    name: secondary ? `${primary.name}+${secondary.name}` : primary.name,
    fallbacks,
    decode(format: Exclude<DecodableFormat, "gif">, bytes: Uint8Array) {
      return run(`${format} decode`, () => primary.decode(format, bytes), secondary && (() => secondary.decode(format, bytes)));
    },
    encode(format: OutputFormat, img: RawImage, s: EncodeSettings) {
      const key = `${format}${s.lossless ? " lossless" : ""} encode`;
      return run(key, () => primary.encode(format, img, s), secondary && (() => secondary.encode(format, img, s)));
    },
    resize(img: RawImage, w: number, h: number) {
      const a = primary.resize ? () => primary.resize!(img, w, h) : undefined;
      const b = secondary?.resize ? () => secondary.resize!(img, w, h) : undefined;
      if (!a) {
        if (!b) return Promise.reject(new Error("No resize implementation available"));
        return b();
      }
      return run("resize", a, b);
    },
    codecName(format: OutputFormat, s: EncodeSettings) {
      const key = `${format}${s.lossless ? " lossless" : ""} encode`;
      return broken.has(key) && secondary ? secondary.codecName(format, s) : primary.codecName(format, s);
    },
  };
  if (primary.optimisePng) backend.optimisePng = (bytes, s) => primary.optimisePng!(bytes, s);
  return backend;
}
