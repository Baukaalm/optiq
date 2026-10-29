// Minimal WebAssembly entry point for Google's jpegli encoder (github.com/google/jpegli, BSD-3-Clause).
// Settings mirror `cjpegli -q Q --chroma_subsampling=...`: quality is mapped to a butteraugli distance, adaptive
// quantization, optimized Huffman coding and progressive level 2. No ICC/APP markers beyond JFIF: Optiq injects
// metadata itself.
#include <setjmp.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten/emscripten.h>

#include "jpegli/encode.h"

namespace {
void ErrorExit(j_common_ptr cinfo) { longjmp(*static_cast<jmp_buf*>(cinfo->client_data), 1); }
void Silent(j_common_ptr, int) {}

uint8_t* g_out = nullptr;
unsigned long g_out_size = 0;
}  // namespace

extern "C" {

// Encodes RGBA pixels (alpha ignored). chroma: 420 or 444. Returns the output size, or 0 on error.
// The output stays valid until the next call or jpegli_free_output().
EMSCRIPTEN_KEEPALIVE unsigned long jpegli_encode(const uint8_t* rgba, int width, int height, float quality,
                                                 int chroma, int progressive_level) {
  free(g_out);
  g_out = nullptr;
  g_out_size = 0;
  jpeg_compress_struct cinfo;
  jpeg_error_mgr jerr;
  jmp_buf env;
  uint8_t* row = nullptr;
  cinfo.err = jpegli_std_error(&jerr);
  jerr.error_exit = &ErrorExit;
  jerr.emit_message = &Silent;
  cinfo.client_data = &env;
  if (setjmp(env)) {
    jpegli_destroy_compress(&cinfo);
    free(row);
    free(g_out);
    g_out = nullptr;
    g_out_size = 0;
    return 0;
  }
  jpegli_create_compress(&cinfo);
  jpegli_mem_dest(&cinfo, &g_out, &g_out_size);
  cinfo.image_width = width;
  cinfo.image_height = height;
  cinfo.input_components = 3;
  cinfo.in_color_space = JCS_RGB;
  jpegli_set_defaults(&cinfo);
  int s = chroma == 444 ? 1 : 2;
  cinfo.comp_info[0].h_samp_factor = s;
  cinfo.comp_info[0].v_samp_factor = s;
  for (int i = 1; i < cinfo.num_components; ++i) {
    cinfo.comp_info[i].h_samp_factor = 1;
    cinfo.comp_info[i].v_samp_factor = 1;
  }
  jpegli_enable_adaptive_quantization(&cinfo, TRUE);
  jpegli_set_distance(&cinfo, jpegli_quality_to_distance(quality), TRUE);
  jpegli_set_progressive_level(&cinfo, progressive_level);
  cinfo.optimize_coding = TRUE;
  jpegli_start_compress(&cinfo, TRUE);
  row = static_cast<uint8_t*>(malloc(static_cast<size_t>(width) * 3));
  for (int y = 0; y < height; ++y) {
    const uint8_t* src = rgba + static_cast<size_t>(y) * width * 4;
    for (int x = 0; x < width; ++x) memcpy(row + x * 3, src + x * 4, 3);
    JSAMPROW rows[1] = {row};
    jpegli_write_scanlines(&cinfo, rows, 1);
  }
  jpegli_finish_compress(&cinfo);
  jpegli_destroy_compress(&cinfo);
  free(row);
  return g_out_size;
}

EMSCRIPTEN_KEEPALIVE uint8_t* jpegli_output() { return g_out; }

EMSCRIPTEN_KEEPALIVE void jpegli_free_output() {
  free(g_out);
  g_out = nullptr;
  g_out_size = 0;
}
}
