// Many files at once: one hook per file (each runs in the shared worker pool, two at a time by default),
// per-file status, and a running total of the bytes saved.
import { useCallback, useEffect, useState } from "react";
import { useOptiq } from "optiq-image/react";
import type { CompressionResult } from "optiq-image";

type SetResult = (id: string, r: CompressionResult | null) => void;

function GalleryItem({ id, file, setResult, onRemove }: { id: string; file: File; setResult: SetResult; onRemove: () => void }) {
  const { status, result, progress, cancel } = useOptiq(file, { mode: "balanced", maxWidthOrHeight: 2048 });

  // setResult is stable (useCallback in the parent), so this only runs when this item's state changes.
  useEffect(() => setResult(id, status === "done" && result ? result : null), [id, status, result, setResult]);

  return (
    <li>
      <strong>{file.name}</strong>{" "}
      {status === "compressing" && (
        <>
          <progress value={progress?.progress ?? 0} max={1} /> <button onClick={cancel}>Cancel</button>
        </>
      )}
      {status === "done" && result && <span>−{Math.round(result.sizeReductionRatio * 100)}% · {result.outputFormat}</span>}
      {status === "error" && <span>kept original</span>}
      {status === "cancelled" && <span>cancelled</span>}{" "}
      <button onClick={onRemove}>Remove</button>
    </li>
  );
}

export function GalleryUploader() {
  const [files, setFiles] = useState<File[]>([]);
  const [results, setResults] = useState<Record<string, CompressionResult | null>>({});
  const keyOf = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;
  const setResult = useCallback<SetResult>((id, r) => setResults((all) => (all[id] === r ? all : { ...all, [id]: r })), []);

  const done = Object.values(results).filter((r): r is CompressionResult => !!r);
  const before = done.reduce((s, r) => s + r.originalBytes, 0);
  const after = done.reduce((s, r) => s + r.outputBytes, 0);

  return (
    <div>
      <input type="file" accept="image/*" multiple onChange={(e) => setFiles((fs) => [...fs, ...Array.from(e.target.files ?? [])])} />
      <ul>
        {files.map((f) => (
          <GalleryItem key={keyOf(f)} id={keyOf(f)} file={f} setResult={setResult} onRemove={() => setFiles((fs) => fs.filter((x) => x !== f))} />
        ))}
      </ul>
      {done.length > 0 && (
        <p>
          {done.length}/{files.length} ready · {(before / 1048576).toFixed(1)} MB → {(after / 1048576).toFixed(1)} MB
        </p>
      )}
    </div>
  );
}
