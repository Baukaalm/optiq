# React hook

```sh
npm i optiq-image   # react >= 18 is an optional peer dependency
```

```tsx
import { useState } from "react";
import { useOptiq } from "optiq-image/react";

export function AvatarPicker({ onReady }: { onReady: (file: Blob, name: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const { status, result, progress, error, cancel } = useOptiq(file, { mode: "fast", maxWidthOrHeight: 1024 });

  return (
    <div>
      <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      {status === "compressing" && (
        <p>
          {progress?.stage} {Math.round((progress?.progress ?? 0) * 100)}% <button onClick={cancel}>Cancel</button>
        </p>
      )}
      {status === "done" && result && (
        <button onClick={() => onReady(result.blob, result.fileName)}>
          Use it ({Math.round(result.sizeReductionRatio * 100)}% smaller)
        </button>
      )}
      {status === "error" && file && <button onClick={() => onReady(file, file.name)}>Upload original</button>}
    </div>
  );
}
```

- `status`: `idle | compressing | done | error | cancelled`.
- The job restarts when `file` or the options change. Options are compared by value, so an inline object does not
  restart it on every render. The previous job is aborted (its worker is terminated), and so is the running job
  on unmount.
- `enabled: false` keeps the hook idle; `compressor` lets you pass your own `createCompressor()` pool.
- On error the original file is untouched; upload it instead.

## Example: photo upload form

Compress on the device, show progress and the saving, upload through a presigned S3 URL, and fall back to the
original file if compression or upload fails. (This file is type-checked in CI against the real package types.)

::: details View example: PhotoUploadForm.tsx
<<< @/examples/PhotoUploadForm.tsx
:::

[Source on GitHub](https://github.com/Baukaalm/optiq/blob/main/docs/examples/PhotoUploadForm.tsx)

## Example: several files at once

One hook per file. Jobs share the default worker pool (two at a time), so a long list does not freeze the page or
start dozens of encoders.

::: details View example: GalleryUploader.tsx
<<< @/examples/GalleryUploader.tsx
:::

[Source on GitHub](https://github.com/Baukaalm/optiq/blob/main/docs/examples/GalleryUploader.tsx)


