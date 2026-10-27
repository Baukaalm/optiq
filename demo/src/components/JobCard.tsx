import { Alert, Button, Card, Chip, Disclosure, ProgressBar } from "@heroui/react";
import { formatBytes, formatMs, formatPct, STAGE_LABEL } from "../format";
import type { Job } from "../useJobs";
import { CandidatesTable } from "./CandidatesTable";
import { CompareSlider } from "./CompareSlider";

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-xl bg-default/40 px-3 py-2">
      <p className="text-xs text-muted">{label}</p>
      <p className={`text-base font-semibold tabular-nums ${tone === "good" ? "text-success" : tone === "bad" ? "text-danger" : ""}`}>{value}</p>
    </div>
  );
}

function Section({ title, children, testId, open }: { title: string; children: React.ReactNode; testId?: string; open?: boolean }) {
  return (
    <Disclosure data-testid={testId} defaultExpanded={open}>
      <Disclosure.Heading>
        <Button slot="trigger" variant="ghost" size="sm">
          {title}
          <Disclosure.Indicator />
        </Button>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="pt-2">{children}</Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}

export function JobCard({ job, onCancel, onRemove, onRetry, onUpload }: { job: Job; onCancel: () => void; onRemove: () => void; onRetry: () => void; onUpload: (which: "optimized" | "original") => void }) {
  const r = job.result;
  const p = job.progress;
  const busy = job.upload.state === "uploading";
  const chosen = r ? `${r.codec}|${Object.entries(r.settings ?? {}).map(([k, v]) => `${k}=${v}`).join(" ")}|${r.outputBytes}` : undefined;
  return (
    <Card data-testid="job" data-status={job.status}>
      <Card.Header className="flex flex-row items-start gap-3">
        <img src={job.originalUrl} alt="" className="checkerboard size-14 shrink-0 rounded-lg border border-border object-cover" />
        <div className="min-w-0 flex-1">
          <Card.Title className="truncate" title={job.file.name}>
            {job.file.name}
          </Card.Title>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Chip size="sm" variant="secondary">{formatBytes(job.file.size)}</Chip>
            {r && (
              <>
                <Chip size="sm" variant="secondary">
                  {r.originalFormat.toUpperCase()} → {r.outputFormat.toUpperCase()}
                </Chip>
                {r.category && <Chip size="sm" variant="soft">{r.category}</Chip>}
                <Chip size="sm" variant="soft" color={r.qualityMetricName === "exact" ? "success" : "accent"}>
                  {r.qualityMetricName === "exact" ? "pixel-exact" : `SSIM ${r.qualityMetric?.toFixed(4)}`}
                </Chip>
              </>
            )}
            {job.status === "failed" && <Chip size="sm" color="danger">failed</Chip>}
            {job.status === "cancelled" && <Chip size="sm" color="warning">cancelled</Chip>}
          </div>
        </div>
        <Button variant="ghost" size="sm" isIconOnly aria-label="Remove" onPress={onRemove}>
          ✕
        </Button>
      </Card.Header>

      <Card.Content className="flex flex-col gap-4">
        {job.status === "compressing" && (
          <ProgressBar value={Math.round((p?.progress ?? 0) * 100)} aria-label="Compression progress" data-testid="progress">
            <div className="flex w-full justify-between text-sm">
              <span data-testid="stage">
                {STAGE_LABEL[p?.stage ?? "reading"]}
                {p?.candidateBudget ? ` · ${p.candidatesTried}/${p.candidateBudget}` : ""}
              </span>
              <span className="text-muted tabular-nums">{p?.bestBytes ? `best so far ${formatPct(1 - p.bestBytes / job.file.size)}` : ""}</span>
            </div>
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
        )}

        {job.status === "failed" && (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Compression failed</Alert.Title>
              <Alert.Description>{job.error} — the original file is untouched and can still be uploaded.</Alert.Description>
            </Alert.Content>
          </Alert>
        )}

        {r && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="stats">
              <Stat label="Optimised" value={formatBytes(r.outputBytes)} />
              <Stat label="Saved" value={formatPct(r.sizeReductionRatio)} tone={r.sizeReductionRatio > 0 ? "good" : undefined} />
              <Stat label="Size" value={r.width && r.height ? `${r.width}×${r.height}` : "–"} />
              <Stat label="Time" value={formatMs(r.durationMs)} />
            </div>
            {r.usedOriginal && (
              <Alert status="default">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>The original is already optimal</Alert.Title>
                  <Alert.Description>No candidate met the constraints with a meaningful saving, so the input is returned unchanged.</Alert.Description>
                </Alert.Content>
              </Alert>
            )}
            {(!r.constraintsMet || r.fallbacks.length > 0) && (
              <Alert status="warning">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>{r.constraintsMet ? "Fallback used" : "Some constraints could not be met"}</Alert.Title>
                  <Alert.Description>
                    <ul className="list-disc pl-4">
                      {r.unmetConstraints.map((u, i) => (
                        <li key={`u${i}`}>{u.constraint}: {"limit" in u ? `limit ${u.limit}, got ${u.actual}` : u.reason}</li>
                      ))}
                      {r.fallbacks.map((w, i) => (
                        <li key={`f${i}`}>{w}</li>
                      ))}
                    </ul>
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            )}
            {r.warnings.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted" data-testid="notes">
                {r.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
            {job.outputUrl && !r.usedOriginal && r.outputFormat !== "svg" && (
              <Section title="Compare before / after" testId="compare" open={job.sample}>
                <CompareSlider before={job.originalUrl} after={job.outputUrl} label={job.file.name} />
              </Section>
            )}
            <Section title={`Candidates tried (${r.candidates.length})`}>
              <CandidatesTable candidates={r.candidates} chosen={chosen} />
            </Section>
          </>
        )}

        {job.upload.state === "uploading" && (
          <ProgressBar value={Math.round(job.upload.progress * 100)} aria-label="Upload progress" color="success" size="sm">
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
        )}
        {job.upload.state === "uploaded" && (
          <Alert status="success" data-testid="uploaded">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>
                {job.upload.simulated ? "Simulated upload of" : "Uploaded"} {job.upload.which} · {formatBytes(job.upload.bytes)}
              </Alert.Title>
              <Alert.Description>
                <a className="underline" href={job.upload.href} target="_blank" rel="noreferrer" data-testid="uploaded-link">
                  {job.upload.key}
                </a>
                {job.upload.simulated && (
                  <span className="block text-xs">
                    This hosted demo has no backend: the presigned URL and the PUT are simulated in your browser and nothing is sent anywhere.
                    Run the demo locally for the full flow against a mock presigning server.
                  </span>
                )}
              </Alert.Description>
            </Alert.Content>
          </Alert>
        )}
        {job.upload.state === "failed" && (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Upload failed</Alert.Title>
              <Alert.Description>{job.upload.message} — nothing was lost; retry or upload the original.</Alert.Description>
            </Alert.Content>
          </Alert>
        )}
      </Card.Content>

      <Card.Footer className="flex flex-wrap gap-2">
        {job.status === "compressing" ? (
          <Button variant="danger-soft" onPress={onCancel} data-testid="cancel">
            Cancel
          </Button>
        ) : (
          <>
            <Button variant="primary" isDisabled={!r || r.usedOriginal || busy} onPress={() => onUpload("optimized")} data-testid="upload">
              Upload optimised
            </Button>
            <Button variant="secondary" isDisabled={busy} onPress={() => onUpload("original")} data-testid="upload-original">
              Upload original
            </Button>
            {r && job.outputUrl && (
              <a href={job.outputUrl} download={r.fileName} className="button button--tertiary">
                Download
              </a>
            )}
            {(job.status === "cancelled" || job.status === "failed") && (
              <Button variant="ghost" onPress={onRetry} data-testid="retry">
                Retry
              </Button>
            )}
          </>
        )}
      </Card.Footer>
    </Card>
  );
}
