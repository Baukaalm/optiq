import { Card, Description, Label, ListBox, Select, Switch } from "@heroui/react";
import type { CompressionMode } from "optiq-image";

export interface Settings {
  mode: CompressionMode;
  maxSide: string;
  keepMetadata: boolean;
  allowAvif: boolean;
}

const MODES: { id: CompressionMode; label: string; hint: string }[] = [
  { id: "fast", label: "Fast", hint: "SSIM ≥ 0.975, no AVIF, ≤ 5 encodes. Best for phones and batches." },
  { id: "balanced", label: "Balanced", hint: "SSIM ≥ 0.975, all formats incl. AVIF. Pixels change." },
  { id: "visually-lossless", label: "Visually lossless", hint: "SSIM ≥ 0.99, larger search. Pixels change." },
  { id: "lossless", label: "Lossless", hint: "Decoded pixels verified identical." },
];

const SIDES = [
  { id: "none", label: "Keep original size" },
  { id: "4096", label: "4096 px" },
  { id: "2560", label: "2560 px" },
  { id: "1920", label: "1920 px" },
  { id: "1280", label: "1280 px" },
];

function Toggle({ label, hint, isSelected, onChange, testId }: { label: string; hint: string; isSelected: boolean; onChange: (v: boolean) => void; testId: string }) {
  // HeroUI v3: the root (SwitchField) holds the state; Switch.Content is the interactive element, so the whole row
  // (text + control) toggles and the label is announced to screen readers.
  return (
    <Switch isSelected={isSelected} onChange={onChange} data-testid={testId} className="w-full">
      <Switch.Content className="flex w-full cursor-pointer items-start justify-between gap-4">
        <span className="flex flex-col">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-xs text-muted">{hint}</span>
        </span>
        <Switch.Control className="shrink-0">
          <Switch.Thumb />
        </Switch.Control>
      </Switch.Content>
    </Switch>
  );
}

export function SettingsPanel({ value, onChange }: { value: Settings; onChange: (s: Settings) => void }) {
  const mode = MODES.find((m) => m.id === value.mode)!;
  return (
    <Card className="lg:sticky lg:top-6">
      <Card.Header>
        <Card.Title>Settings</Card.Title>
        <Card.Description>Applied to newly added files. Use “Re-run” on a file to apply changes.</Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-5">
        <Select selectedKey={value.mode} onSelectionChange={(k) => onChange({ ...value, mode: k as CompressionMode })} data-testid="mode">
          <Label>Mode</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Description>{mode.hint}</Description>
          <Select.Popover>
            <ListBox>
              {MODES.map((m) => (
                <ListBox.Item key={m.id} id={m.id} textValue={m.label}>
                  {m.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>

        <Select selectedKey={value.maxSide} onSelectionChange={(k) => onChange({ ...value, maxSide: String(k) })}>
          <Label>Longest side</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Description>Downscaling is opt-in; in lossless mode it is explicitly allowed here.</Description>
          <Select.Popover>
            <ListBox>
              {SIDES.map((s) => (
                <ListBox.Item key={s.id} id={s.id} textValue={s.label}>
                  {s.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>

        <Toggle
          label="Keep metadata"
          hint="EXIF (incl. GPS) and XMP. Off strips them; colour profiles that matter are kept anyway."
          isSelected={value.keepMetadata}
          onChange={(keepMetadata) => onChange({ ...value, keepMetadata })}
          testId="keep-metadata"
        />
        <Toggle
          label="Allow AVIF"
          hint="Smallest files, slowest encoder. Needs Safari 16.4+ / Chrome 85+ / Firefox 93+ to display."
          isSelected={value.allowAvif}
          onChange={(allowAvif) => onChange({ ...value, allowAvif })}
          testId="allow-avif"
        />
      </Card.Content>
    </Card>
  );
}
