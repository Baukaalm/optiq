import { useCallback, useEffect, useRef, useState } from "react";
import { compressImage, isSmartCompressError, type CompressionResult, type ProgressEvent, type SmartCompressOptions } from "smartcompress";
import { uploadToPresignedUrl } from "smartcompress/upload";
import { objectHref, requestPresignedUpload, simulatedTransport, uploadMode } from "./api";

export type JobStatus = "compressing" | "done" | "failed" | "cancelled";
export type UploadState =
  | { state: "idle" }
  | { state: "uploading"; which: "optimized" | "original"; progress: number }
  | { state: "uploaded"; which: "optimized" | "original"; key: string; href: string; bytes: number; simulated: boolean }
  | { state: "failed"; message: string };

export interface Job {
  id: string;
  file: File;
  originalUrl: string;
  outputUrl?: string;
  status: JobStatus;
  progress?: ProgressEvent;
  result?: CompressionResult;
  error?: string;
  options: SmartCompressOptions;
  upload: UploadState;
  /** Added from the built-in samples. */
  sample?: boolean;
}

let seq = 0;

export function useJobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  const patch = useCallback((id: string, p: Partial<Job> | ((j: Job) => Partial<Job>)) => {
    setJobs((list) => list.map((j) => (j.id === id ? { ...j, ...(typeof p === "function" ? p(j) : p) } : j)));
  }, []);

  const run = useCallback(
    async (id: string, file: File, options: SmartCompressOptions) => {
      controllers.current.get(id)?.abort();
      const ac = new AbortController();
      controllers.current.set(id, ac);
      patch(id, (j) => {
        if (j.outputUrl) URL.revokeObjectURL(j.outputUrl);
        return { status: "compressing", progress: undefined, result: undefined, error: undefined, outputUrl: undefined, options, upload: { state: "idle" } };
      });
      try {
        const result = await compressImage(file, { ...options, signal: ac.signal, onProgress: (progress) => patch(id, { progress }) });
        patch(id, { status: "done", result, outputUrl: URL.createObjectURL(result.blob) });
      } catch (e) {
        if (ac.signal.aborted) patch(id, { status: "cancelled" });
        else patch(id, { status: "failed", error: isSmartCompressError(e) ? `${e.code}: ${e.message}` : String(e) });
      } finally {
        if (controllers.current.get(id) === ac) controllers.current.delete(id);
      }
    },
    [patch],
  );

  const add = useCallback(
    (files: File[], options: SmartCompressOptions, sample = false) => {
      const created = files.map((file) => ({
        id: `job-${++seq}`,
        file,
        originalUrl: URL.createObjectURL(file),
        status: "compressing" as const,
        options,
        upload: { state: "idle" } as UploadState,
        sample,
      }));
      setJobs((list) => [...created, ...list]);
      for (const j of created) void run(j.id, j.file, options);
    },
    [run],
  );

  const cancel = useCallback((id: string) => controllers.current.get(id)?.abort(), []);

  const remove = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    setJobs((list) => {
      const j = list.find((x) => x.id === id);
      if (j) {
        URL.revokeObjectURL(j.originalUrl);
        if (j.outputUrl) URL.revokeObjectURL(j.outputUrl);
      }
      return list.filter((x) => x.id !== id);
    });
  }, []);

  const upload = useCallback(
    async (id: string, which: "optimized" | "original") => {
      const job = jobsRef.current.find((j) => j.id === id);
      if (!job) return;
      const r = which === "optimized" ? job.result : undefined;
      const body: Blob = r ? r.blob : job.file;
      const fileName = r ? r.fileName : job.file.name;
      const contentType = r ? r.mimeType : job.file.type || "application/octet-stream";
      patch(id, { upload: { state: "uploading", which, progress: 0 } });
      try {
        const target = await requestPresignedUpload({ fileName, contentType, size: body.size });
        await uploadToPresignedUrl(body, target, {
          contentType,
          fileName,
          onProgress: (p) => patch(id, { upload: { state: "uploading", which, progress: p.total ? p.loaded / p.total : 0 } }),
          transport: uploadMode === "simulated" ? simulatedTransport : undefined,
        });
        const key = target.key ?? "";
        patch(id, { upload: { state: "uploaded", which, key, href: objectHref(key), bytes: body.size, simulated: uploadMode === "simulated" } });
      } catch (e) {
        patch(id, { upload: { state: "failed", message: e instanceof Error ? e.message : String(e) } });
      }
    },
    [patch],
  );

  useEffect(
    () => () => {
      for (const c of controllers.current.values()) c.abort();
    },
    [],
  );

  return { jobs, add, run, cancel, remove, upload };
}
