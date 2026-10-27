import type { HttpTransport, PresignRequest, PresignedUpload } from "smartcompress/upload";

/**
 * "server": the dev/preview server answers /api/presign and /mock-s3 (see vite.config.ts) like a real backend + S3.
 * "simulated": static hosting (GitHub Pages) has no backend, so presign + PUT are simulated in the page and the
 * "uploaded" object is kept in memory. Set with VITE_UPLOAD_MODE=simulated at build time.
 */
export const uploadMode: "server" | "simulated" = import.meta.env.VITE_UPLOAD_MODE === "simulated" ? "simulated" : "server";

const simulatedObjects = new Map<string, Blob>();

export async function requestPresignedUpload(req: PresignRequest): Promise<PresignedUpload> {
  if (uploadMode === "simulated") {
    const key = `uploads/${crypto.randomUUID()}-${req.fileName.replace(/[^\w.-]/g, "_")}`;
    return { url: `simulated://bucket/${key}`, method: "PUT", key };
  }
  // Your backend: authenticate the user, validate type and size, return a short-lived presigned URL.
  const res = await fetch(`${import.meta.env.BASE_URL}api/presign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fileName: req.fileName, contentType: req.contentType, size: req.size }),
    signal: req.signal,
  });
  if (!res.ok) throw new Error(`Presign failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/** Pretends to PUT the body (progress included) and stores it in memory. */
export const simulatedTransport: HttpTransport = async (req) => {
  const body = req.body as Blob;
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    if (req.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await new Promise((r) => setTimeout(r, 40));
    req.onProgress?.({ loaded: Math.round((body.size * i) / steps), total: body.size });
  }
  simulatedObjects.set(req.url.replace("simulated://bucket/", ""), new Blob([body], { type: req.headers["Content-Type"] }));
  return { status: 200, headers: {} };
};

/** Where the uploaded object can be viewed. */
export function objectHref(key: string): string {
  if (uploadMode === "simulated") {
    const blob = simulatedObjects.get(key);
    return blob ? URL.createObjectURL(blob) : "#";
  }
  return `${import.meta.env.BASE_URL}mock-s3/${key}`;
}
