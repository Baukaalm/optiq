// Types for the Emscripten module built by codecs/jpegli/build.sh.
export interface JpegliModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  /** Returns the output size, or 0 on error. chroma: 420 or 444. */
  _jpegli_encode(rgba: number, width: number, height: number, quality: number, chroma: number, progressiveLevel: number): number;
  _jpegli_output(): number;
  _jpegli_free_output(): void;
}
export interface JpegliModuleOptions {
  instantiateWasm?: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) => object;
}
export default function createModule(options?: JpegliModuleOptions): Promise<JpegliModule>;
