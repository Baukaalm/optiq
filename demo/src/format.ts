export const formatBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;

export const formatMs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

export const formatPct = (r: number): string => `${r >= 0 ? "−" : "+"}${Math.abs(r * 100).toFixed(1)}%`;

export const STAGE_LABEL: Record<string, string> = {
  reading: "Reading file",
  probing: "Detecting format",
  decoding: "Decoding",
  resizing: "Resizing",
  analyzing: "Classifying content",
  encoding: "Trying encodings",
  finalizing: "Finalizing",
  done: "Done",
};
