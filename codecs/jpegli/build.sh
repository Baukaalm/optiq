#!/usr/bin/env bash
# Builds vendor/jpegli/jpegli_enc.{js,wasm} from Google's jpegli (BSD-3-Clause) with Emscripten.
# Reproducible: the jpegli commit is pinned (it pins Highway, skcms and libjpeg-turbo headers as submodules), and the
# Emscripten version is checked. CI rebuilds and compares the output byte for byte (.github/workflows/ci.yml).
# Usage: codecs/jpegli/build.sh [work-dir]   (needs emcc/em++/emcmake, cmake, ninja, git)
set -euo pipefail

JPEGLI_COMMIT=031a0077f5799a6041004267fc12b956c1f52a20
EMSCRIPTEN_VERSION=6.0.13

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
work="${1:-$root/.cache/jpegli-build}"
out="${JPEGLI_OUT:-$root/vendor/jpegli}"

have="$(emcc --version | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
if [ "$have" != "$EMSCRIPTEN_VERSION" ]; then
  echo "Emscripten $EMSCRIPTEN_VERSION required (found $have); output would not be byte-identical" >&2
  exit 1
fi

if [ ! -d "$work/src/.git" ]; then
  mkdir -p "$work"
  git clone --quiet https://github.com/google/jpegli.git "$work/src"
fi
git -C "$work/src" fetch --quiet origin "$JPEGLI_COMMIT"
git -C "$work/src" checkout --quiet "$JPEGLI_COMMIT"
git -C "$work/src" submodule update --init --depth 1 --quiet third_party/highway third_party/skcms third_party/lcms third_party/libjpeg-turbo

src="$work/src"
build="$work/build-wasm"
emcmake cmake -S "$src" -B "$build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF -DJPEGLI_STATIC=ON \
  -DJPEGLI_ENABLE_TOOLS=OFF -DJPEGLI_ENABLE_SJPEG=OFF -DJPEGLI_ENABLE_WASM_THREADS=OFF \
  -DJPEGLI_ENABLE_BENCHMARK=OFF -DJPEGLI_ENABLE_JNI=OFF -DJPEGLI_ENABLE_OPENEXR=OFF -DJPEGLI_ENABLE_TCMALLOC=OFF \
  -DJPEGLI_ENABLE_DOXYGEN=OFF -DJPEGLI_ENABLE_MANPAGES=OFF -DJPEGLI_ENABLE_DEVTOOLS=OFF -DJPEGLI_BUNDLE_LIBPNG=OFF \
  >/dev/null
cmake --build "$build" --target jpegli-static >/dev/null

mkdir -p "$out"
# web,worker only (like the jSquash builds): Node gets the compiled module from optiq-image/node, so no Node code
# ends up in browser bundles. ES module; the .wasm is located with new URL(..., import.meta.url) for bundlers.
em++ "$here/jpegli_enc.cc" -O3 \
  -I"$src" -I"$src/lib" -I"$build/lib/include" -I"$build/lib/include/jpegli" \
  "$build/lib/libjpegli-static.a" "$build/third_party/highway/libhwy.a" \
  -o "$out/jpegli_enc.js" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker -sALLOW_MEMORY_GROWTH=1 -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS=_jpegli_encode,_jpegli_output,_jpegli_free_output,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8

cp "$src/LICENSE" "$out/LICENSE.jpegli"
cp "$src/third_party/highway/LICENSE" "$out/LICENSE.highway"
cp "$src/third_party/skcms/LICENSE" "$out/LICENSE.skcms"
echo "jpegli $JPEGLI_COMMIT, emscripten $EMSCRIPTEN_VERSION" > "$out/VERSION"
ls -l "$out"
