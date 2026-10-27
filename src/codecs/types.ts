import type { RawImage } from "../pixels.js";
import type { DecodableFormat, OutputFormat } from "../types.js";

/** Codec-specific settings; also reported verbatim in `CandidateReport.settings`. */
export type EncodeSettings = Record<string, number | boolean | string>;

export interface CodecBackend {
  readonly name: string;
  /** Decode to 8-bit RGBA without applying EXIF orientation. */
  decode(format: Exclude<DecodableFormat, "gif">, bytes: Uint8Array): Promise<RawImage>;
  encode(format: OutputFormat, img: RawImage, settings: EncodeSettings): Promise<Uint8Array>;
  /** Lossless PNG re-compression of existing PNG bytes (keeps ancillary chunks). */
  optimisePng?(bytes: Uint8Array, settings: EncodeSettings): Promise<Uint8Array>;
  resize?(img: RawImage, width: number, height: number): Promise<RawImage>;
  /** Human-readable codec label for reports, e.g. "mozjpeg". */
  codecName(format: OutputFormat, settings: EncodeSettings): string;
}
