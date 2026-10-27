# Errors, cancellation, fallbacks

All failures reject with `OptiqError` (`isOptiqError(e)`), which has a `code` and sometimes
`details`. Messages never contain image data or metadata.

| Code | When | What to do |
|---|---|---|
| `INVALID_INPUT` | Not a `Blob`/`File`, or empty | – |
| `UNSUPPORTED_FORMAT` | Unknown bytes, or HEIC/HEIF | Upload the original, or convert server-side |
| `MALFORMED_INPUT` | Truncated or corrupt file | Upload the original if your backend accepts it |
| `INPUT_TOO_LARGE` | Over `maxInputBytes` / `maxInputPixels` | Raise the limits deliberately, or reject |
| `INVALID_OPTIONS` | Option out of range | Fix the call |
| `INCOMPATIBLE_OPTIONS` | Options conflict with this image | Read the message; it names the option |
| `CONSTRAINTS_UNSATISFIABLE` | `onUnmetConstraints: "throw"` and a constraint cannot be met | Relax a constraint |
| `CODEC_UNAVAILABLE` | No encoder could run for the required format | Check CSP; allow fallback |
| `UNSUPPORTED_ENVIRONMENT` | No Web Workers (and `allowMainThread` not set) | Upload the original |
| `WORKER_ERROR` | Worker crashed or failed to load | Check how the worker file is served |
| `ABORTED` | `signal` aborted (`name === "AbortError"`) | – |

Compression is always optional: in every case the original file is untouched and can be uploaded instead.
`compressAndUpload` does this automatically.

## Cancellation

Aborting a queued job removes it; aborting a running job **terminates its worker**, because a WASM encode cannot be
interrupted. A new worker is started for the next job. Measured abort latency in Chromium: under 1 ms.

## Fallbacks

| Situation | Behaviour | Reported in |
|---|---|---|
| A WASM codec cannot load (e.g. CSP without `'wasm-unsafe-eval'`) | The browser's own encoder/decoder via `OffscreenCanvas` | `result.fallbacks` |
| A format has no working encoder at all (canvas cannot encode AVIF in Chromium) | That format is skipped, others continue | `result.warnings` |
| `codecFallback: "none"` | No canvas fallback | – |
| No Web Workers | `UNSUPPORTED_ENVIRONMENT`, or main thread with `allowMainThread: true` | `result.fallbacks` |

Canvas fallback limits: premultiplied alpha (semi-transparent pixels may not round-trip, so lossless candidates can
fail verification and the original is returned), no lossless WebP, no encoder tuning.
