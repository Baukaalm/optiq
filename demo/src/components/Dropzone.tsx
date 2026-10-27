import { Button } from "@heroui/react";
import { useRef, useState } from "react";

export function Dropzone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const take = (list: FileList | null) => {
    const files = [...(list ?? [])];
    if (files.length) onFiles(files);
  };
  return (
    <div
      data-testid="dropzone"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        take(e.dataTransfer.files);
      }}
      className={`flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
        over ? "border-accent bg-accent/5" : "border-border bg-surface"
      }`}
    >
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted" aria-hidden>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-4.5-4.5L6 21" />
      </svg>
      <div>
        <p className="font-medium">Drop images here</p>
        <p className="text-sm text-muted">JPEG, PNG, WebP, AVIF, GIF, SVG · processed on this device, in a Web Worker</p>
      </div>
      <Button variant="secondary" onPress={() => input.current?.click()}>
        Choose files
      </Button>
      <input
        ref={input}
        data-testid="file-input"
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          take(e.currentTarget.files);
          e.currentTarget.value = "";
        }}
      />
    </div>
  );
}
