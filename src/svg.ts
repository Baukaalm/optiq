/**
 * SVG optimisation with SVGO, verified by rendering. SVGO (MIT) rewrites the markup; resvg (MPL-2.0, Rust → WASM)
 * renders the input and every candidate to pixels, and a candidate is kept only if its rendering matches: exactly in
 * `lossless`, and within a strict SSIM bound otherwise. Browsers cannot rasterise SVG inside a Worker, which is why
 * the renderer is WASM; it runs the same in Node.
 *
 * What a static render cannot verify (text without the right fonts, animation, scripts, foreignObject, external
 * resources) gets only markup-level clean-up that leaves geometry, numbers, ids and styles alone.
 * SVGO is not a sanitiser: scripts and event handlers are kept, never removed or vetted.
 */
import type { Config, PluginConfig } from "svgo/browser";
import { ssim } from "./quality.js";
import type { RawImage } from "./pixels.js";

/** Rendering size for verification: the longer side is scaled to this, so small icons are compared magnified. */
const RENDER_SIZE = 512;

let renderer: Promise<typeof import("@resvg/resvg-wasm")> | undefined;

/** Optional: hand over the compiled resvg module (Node, where fetching file: URLs does not work). */
export function initSvgRenderer(wasm?: WebAssembly.Module): Promise<typeof import("@resvg/resvg-wasm")> {
  renderer ??= import("@resvg/resvg-wasm").then(async (m) => {
    await m.initWasm(wasm ?? fetch(new URL("../vendor/resvg/index_bg.wasm", import.meta.url)));
    return m;
  });
  return renderer;
}

/** Features a static render cannot vouch for. Such files only get markup-level clean-up. */
const UNVERIFIABLE: [RegExp, string][] = [
  [/<text[\s>]|<tspan[\s>]|<textPath[\s>]/i, "text (fonts are not available to the verifying renderer)"],
  [/<(animate|animateMotion|animateTransform|set)[\s>]/i, "animation"],
  [/<script[\s>]|\son[a-z]+\s*=/i, "scripts"],
  [/<foreignObject[\s>]/i, "foreignObject"],
  [/(?:href|src)\s*=\s*["']\s*(?:https?:)?\/\//i, "external resources"],
  [/@import|@font-face/i, "external or embedded fonts in CSS"],
];

export interface SvgCandidate {
  preset: "full" | "markup";
  bytes: Uint8Array;
  quality: number;
  exact: boolean;
  passed: boolean;
  note?: string;
}

export interface SvgResult {
  candidates: SvgCandidate[];
  /** Reason the full preset was not tried, if any. */
  unverifiable?: string;
  warnings: string[];
}

function plugins(preset: "full" | "markup", preserveMetadata: boolean): PluginConfig[] {
  const keepMeta = preserveMetadata ? [] : (["removeMetadata"] as const);
  if (preset === "markup") {
    // Never touches geometry, numbers, ids, classes or styles.
    return ["removeDoctype", "removeXMLProcInst", "removeComments", "removeEditorsNSData", "cleanupAttrs", ...keepMeta];
  }
  return [
    {
      name: "preset-default",
      params: {
        overrides: {
          // ids may be referenced from CSS, JS or other documents (<use href="file.svg#id">).
          cleanupIds: false,
          // Keep attributes that scripts, styling hooks and assistive technology rely on.
          removeUnknownsAndDefaults: { keepDataAttrs: true, keepAriaAttrs: true, keepRoleAttr: true },
          ...(preserveMetadata ? { removeMetadata: false } : {}),
        },
      },
    },
  ];
}

const decoder = new TextDecoder();

async function render(svg: Uint8Array, longSide: number): Promise<RawImage> {
  const m = await initSvgRenderer();
  const probe = new m.Resvg(svg);
  const fit = probe.width >= probe.height ? { mode: "width" as const, value: longSide } : { mode: "height" as const, value: longSide };
  probe.free();
  const r = new m.Resvg(svg, { fitTo: fit, font: { loadSystemFonts: false } });
  try {
    const img = r.render();
    try {
      return { data: new Uint8ClampedArray(img.pixels), width: img.width, height: img.height };
    } finally {
      img.free();
    }
  } finally {
    r.free();
  }
}

function equal(a: RawImage, b: RawImage): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

/**
 * Optimise an SVG. `minQuality` is the engine's threshold for the mode (1 in lossless); vector output is held to a
 * five times tighter SSIM bound, because a correct optimisation changes almost nothing visible.
 */
export async function optimizeSvg(input: Uint8Array, minQuality: number, preserveMetadata: boolean): Promise<SvgResult> {
  const { optimize } = await import("svgo/browser");
  const text = decoder.decode(input);
  const warnings: string[] = [];
  const unverifiable = UNVERIFIABLE.find(([re]) => re.test(text))?.[1];
  const lossless = minQuality >= 1;
  const bound = lossless ? 1 : 1 - (1 - minQuality) / 5;

  let reference: RawImage;
  try {
    reference = await render(input, RENDER_SIZE);
  } catch (e) {
    warnings.push(`SVG could not be rendered for verification (${e instanceof Error ? e.message : String(e)}); passed through unchanged`);
    return { candidates: [], warnings };
  }
  if (unverifiable) warnings.push(`SVG contains ${unverifiable}; only markup-level clean-up was applied`);

  const candidates: SvgCandidate[] = [];
  for (const preset of unverifiable ? (["markup"] as const) : (["full", "markup"] as const)) {
    let out: Uint8Array;
    try {
      const config: Config = { multipass: preset === "full", plugins: plugins(preset, preserveMetadata) };
      out = new TextEncoder().encode(optimize(text, config).data);
    } catch (e) {
      candidates.push({ preset, bytes: input, quality: 0, exact: false, passed: false, note: `SVGO failed: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    let rendered: RawImage;
    try {
      rendered = await render(out, RENDER_SIZE);
    } catch {
      candidates.push({ preset, bytes: out, quality: 0, exact: false, passed: false, note: "optimised SVG did not render" });
      continue;
    }
    const exact = equal(reference, rendered);
    const quality = exact ? 1 : rendered.width === reference.width && rendered.height === reference.height ? ssim(reference, rendered).ssim : 0;
    const passed = lossless ? exact : quality >= bound;
    candidates.push({ preset, bytes: out, quality, exact, passed, note: passed ? undefined : `rendering differs (${exact ? "exact" : `SSIM ${quality.toFixed(4)}`} < ${bound})` });
    // The full preset is a superset of the markup clean-up; if it passed there is no need to try less.
    if (preset === "full" && passed) break;
  }
  return { candidates, unverifiable, warnings };
}
