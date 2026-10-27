import { useState } from "react";

/** Before/after comparison: drag (or use arrow keys on) the handle to reveal the optimised image. */
export function CompareSlider({ before, after, label }: { before: string; after: string; label: string }) {
  const [pos, setPos] = useState(50);
  return (
    <div className="checkerboard relative overflow-hidden rounded-xl border border-border text-foreground select-none">
      <img src={before} alt={`Original ${label}`} className="block h-auto max-h-[480px] w-full object-contain" draggable={false} />
      <img
        src={after}
        alt={`Optimised ${label}`}
        className="absolute inset-0 h-full w-full object-contain"
        style={{ clipPath: `inset(0 0 0 ${pos}%)` }}
        draggable={false}
      />
      <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,.35)]" style={{ left: `${pos}%` }} />
      <span className="pointer-events-none absolute top-2 left-2 rounded-md bg-black/60 px-2 py-0.5 text-xs text-white">Original</span>
      <span className="pointer-events-none absolute top-2 right-2 rounded-md bg-black/60 px-2 py-0.5 text-xs text-white">Optimised</span>
      <input
        type="range"
        min={0}
        max={100}
        value={pos}
        onChange={(e) => setPos(Number(e.currentTarget.value))}
        aria-label="Comparison position"
        className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
      />
    </div>
  );
}
