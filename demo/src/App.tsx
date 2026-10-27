import { Chip, Separator } from "@heroui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { OptiqOptions } from "optiq-image";
import { Dropzone } from "./components/Dropzone";
import { JobCard } from "./components/JobCard";
import { loadSample, Samples } from "./components/Samples";
import { SettingsPanel, type Settings } from "./components/SettingsPanel";
import { formatBytes, formatPct } from "./format";
import { useJobs } from "./useJobs";

function toOptions(s: Settings): OptiqOptions {
  const maxWidthOrHeight = s.maxSide === "none" ? undefined : Number(s.maxSide);
  return {
    mode: s.mode,
    maxWidthOrHeight,
    allowLossyResize: maxWidthOrHeight !== undefined,
    preserveMetadata: s.keepMetadata,
    autoFormats: s.allowAvif ? ["jpeg", "png", "webp", "avif"] : ["jpeg", "png", "webp"],
  };
}

export function App() {
  // ?embed hides the hero when the demo is shown inside the documentation site.
  const embedded = new URLSearchParams(location.search).has("embed");
  const [settings, setSettings] = useState<Settings>({ mode: "balanced", maxSide: "none", keepMetadata: true, allowAvif: true });
  const { jobs, add, run, cancel, remove, upload } = useJobs();
  const [sampleError, setSampleError] = useState<string>();
  const addSample = async (name: string) => {
    try {
      add([await loadSample(name)], toOptions(settings), true);
    } catch (e) {
      setSampleError(e instanceof Error ? e.message : String(e));
    }
  };
  // Show a finished example straight away (skip with ?nosample).
  const autoloaded = useRef(false);
  useEffect(() => {
    if (autoloaded.current || new URLSearchParams(location.search).has("nosample")) return;
    autoloaded.current = true;
    void addSample("parrots.jpg");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const totals = useMemo(() => {
    const done = jobs.filter((j) => j.result);
    const before = done.reduce((a, j) => a + j.file.size, 0);
    const after = done.reduce((a, j) => a + j.result!.outputBytes, 0);
    return { count: done.length, before, after };
  }, [jobs]);

  return (
    <div className={`mx-auto max-w-6xl px-4 pb-24 ${embedded ? "pt-4" : ""}`}>
      {!embedded && (
      <header className="flex flex-col items-start gap-4 pt-12 pb-10 sm:pt-16">
        <div className="flex w-full items-center gap-3">
          {/* logo.svg uses currentColor, which <img> cannot inherit: invert it in dark mode instead. */}
          <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="" className="size-9 dark:invert" />
          <span className="text-2xl font-semibold tracking-tight">Optiq</span>
          <span className="flex-1" />
          <a className="button button--tertiary button--sm" href="https://github.com/Baukaalm/optiq" target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a className="button button--tertiary button--sm" href={import.meta.env.BASE_URL === "/" ? "https://baukaalm.github.io/optiq/" : `${import.meta.env.BASE_URL}../`}>
            Docs
          </a>
        </div>
        <div className="flex flex-wrap gap-2">
          <Chip variant="soft" color="accent">Runs in a Web Worker</Chip>
          <Chip variant="soft">MozJPEG · WebP · AVIF · oxipng (WASM)</Chip>
          <Chip variant="soft" color="success">Nothing leaves the page until you upload</Chip>
        </div>
        <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">Smaller uploads, measured quality.</h1>
        <p className="max-w-2xl text-lg text-muted text-pretty">
          Optiq tries several encoders on your device, measures each result, and keeps the smallest one that meets the quality
          constraint — then uploads it to S3 through a presigned URL from your backend.
        </p>
      </header>
      )}

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <aside className="order-2 lg:order-1">
          <SettingsPanel value={settings} onChange={setSettings} />
        </aside>
        <main className="order-1 flex min-w-0 flex-col gap-4 lg:order-2">
          <Dropzone onFiles={(files) => add(files, toOptions(settings))} />
          <Samples onPick={addSample} />
          {sampleError && <p className="text-sm text-danger">{sampleError}</p>}
          {totals.count > 1 && (
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted" data-testid="totals">
              <span>
                {totals.count} files · {formatBytes(totals.before)} → {formatBytes(totals.after)}
              </span>
              <Separator orientation="vertical" className="h-4" />
              <span className="font-medium text-success">{formatPct(1 - totals.after / totals.before)}</span>
            </div>
          )}
          {jobs.length === 0 && (
            <p className="py-8 text-center text-sm text-muted">Add a photo, a screenshot or a transparent PNG — or pick a sample — to see how the result differs by content.</p>
          )}
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onCancel={() => cancel(job.id)}
              onRemove={() => remove(job.id)}
              onRerun={() => run(job.id, job.file, toOptions(settings))}
              onUpload={(which) => upload(job.id, which)}
            />
          ))}
        </main>
      </div>
    </div>
  );
}
