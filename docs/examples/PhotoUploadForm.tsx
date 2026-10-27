// A single-photo upload form: compress on the device, show progress and savings, upload to S3 through a presigned
// URL from your backend, and fall back to the original file if anything goes wrong.
import { useEffect, useMemo, useState } from "react";
import { isOptiqError } from "optiq-image";
import { useOptiq } from "optiq-image/react";
import { uploadToPresignedUrl, type PresignedUpload } from "optiq-image/upload";

async function presign(fileName: string, contentType: string, size: number): Promise<PresignedUpload> {
  const res = await fetch("/api/presign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fileName, contentType, size }),
  });
  if (!res.ok) throw new Error(`presign failed: ${res.status}`);
  return res.json(); // { url, key }
}

const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;

export function PhotoUploadForm({ onUploaded }: { onUploaded: (key: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [upload, setUpload] = useState<{ progress: number } | { error: string } | null>(null);

  // Phones and slow networks: "fast" keeps SSIM >= 0.975 without the 3.5 MB AVIF encoder.
  const { status, result, progress, error, cancel } = useOptiq(file, { mode: "fast", maxWidthOrHeight: 2560 });

  // Preview the optimised image (or the original while compressing); revoke object URLs when they change.
  const previewUrl = useMemo(() => (result ? URL.createObjectURL(result.blob) : file ? URL.createObjectURL(file) : undefined), [file, result]);
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  async function submit() {
    if (!file) return;
    // Compression is optional: use the result when there is one, otherwise the untouched original.
    const body = result && !result.usedOriginal ? result.blob : file;
    const name = result ? result.fileName : file.name;
    const type = result ? result.mimeType : file.type;
    try {
      setUpload({ progress: 0 });
      const target = await presign(name, type, body.size);
      await uploadToPresignedUrl(body, target, {
        contentType: type, // must match what the URL was signed for
        fileName: name,
        onProgress: (p) => setUpload({ progress: p.total ? p.loaded / p.total : 0 }),
      });
      onUploaded(target.key ?? name);
      setFile(null);
      setUpload(null);
    } catch (e) {
      setUpload({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />

      {previewUrl && <img src={previewUrl} alt="" style={{ maxWidth: 320, display: "block", marginTop: 12 }} />}

      {status === "compressing" && (
        <p>
          Optimising… {progress?.stage} <progress value={progress?.progress ?? 0} max={1} />{" "}
          {progress?.bestBytes && file ? `≈ ${Math.round((1 - progress.bestBytes / file.size) * 100)}% smaller so far` : null}{" "}
          <button type="button" onClick={cancel}>
            Cancel
          </button>
        </p>
      )}

      {status === "done" && result && (
        <p>
          {result.usedOriginal
            ? "Already optimal — uploading the original."
            : `${kb(result.originalBytes)} → ${kb(result.outputBytes)} (−${Math.round(result.sizeReductionRatio * 100)}%, ${result.outputFormat.toUpperCase()})`}
        </p>
      )}

      {status === "error" && (
        <p role="alert">
          Could not optimise ({isOptiqError(error) ? error.code : "error"}). The original will be uploaded instead.
        </p>
      )}

      {upload && "error" in upload && <p role="alert">Upload failed: {upload.error}. Your file is still selected — try again.</p>}
      {upload && "progress" in upload && <progress value={upload.progress} max={1} />}

      <button type="submit" disabled={!file || status === "compressing" || (upload !== null && "progress" in upload)}>
        Upload
      </button>
    </form>
  );
}
