import { Button } from "@heroui/react";

export const SAMPLES = [
  { file: "parrots.jpg", label: "Photo", hint: "JPEG, 768×512 (Kodak test image)" },
  { file: "code-screenshot.png", label: "Screenshot", hint: "PNG, 1280×800" },
  { file: "app-icon.png", label: "Transparent icon", hint: "PNG with alpha, 512×512" },
] as const;

export async function loadSample(name: string): Promise<File> {
  const res = await fetch(`${import.meta.env.BASE_URL}samples/${name}`);
  if (!res.ok) throw new Error(`Could not load sample ${name}`);
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type });
}

export function Samples({ onPick, disabled }: { onPick: (name: string) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="samples">
      <span className="text-sm text-muted">No image at hand? Try a sample:</span>
      {SAMPLES.map((s) => (
        <Button key={s.file} size="sm" variant="tertiary" isDisabled={disabled} onPress={() => onPick(s.file)} aria-label={`${s.label}: ${s.hint}`}>
          {s.label}
        </Button>
      ))}
    </div>
  );
}
