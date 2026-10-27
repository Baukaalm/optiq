import { describe, expect, it, vi } from "vitest";
import { OptiqError } from "../../src/errors.js";
import type { CompressionResult } from "../../src/types.js";
import { compressAndUpload, UploadError, uploadToPresignedUrl, type HttpRequest } from "../../src/upload.js";

const file = new File([new Uint8Array(1000)], "pic.png", { type: "image/png" });

function fakeResult(over: Partial<CompressionResult>): CompressionResult {
  const blob = new Blob([new Uint8Array(over.outputBytes ?? 400)], { type: over.mimeType ?? "image/webp" });
  return {
    blob, fileName: "pic.webp", mimeType: "image/webp", originalBytes: 1000, outputBytes: 400, originalFormat: "png", outputFormat: "webp",
    usedOriginal: false, mode: "balanced", durationMs: 1, sizeReductionRatio: 0.6, candidates: [], constraintsMet: true, unmetConstraints: [],
    fallbacks: [], metadata: { exif: "none", xmp: "none", iccProfile: "none", orientation: "none" }, warnings: [], ...over,
  };
}

describe("S3 presigned upload", () => {
  it("PUTs the optimized blob with matching Content-Type and file name", async () => {
    const requests: HttpRequest[] = [];
    const presign = vi.fn(async () => ({ url: "https://bucket.s3.amazonaws.com/k?X-Amz-Signature=abc", key: "uploads/k.webp" }));
    const r = await compressAndUpload(file, {
      requestPresignedUpload: presign,
      compress: async () => fakeResult({}),
      transport: async (req) => (requests.push(req), { status: 200, headers: { etag: '"x"' } }),
    });
    expect(presign).toHaveBeenCalledWith(expect.objectContaining({ fileName: "pic.webp", contentType: "image/webp", size: 400 }));
    expect(requests[0].method).toBe("PUT");
    expect(requests[0].headers["Content-Type"]).toBe("image/webp");
    expect((requests[0].body as Blob).size).toBe(400);
    expect(r).toMatchObject({ uploaded: "optimized", key: "uploads/k.webp", fileName: "pic.webp" });
  });

  it("uploads the original when compression fails, and reports the error", async () => {
    const requests: HttpRequest[] = [];
    const r = await compressAndUpload(file, {
      requestPresignedUpload: async () => ({ url: "https://x/put" }),
      compress: async () => {
        throw new OptiqError("MALFORMED_INPUT", "bad");
      },
      transport: async (req) => (requests.push(req), { status: 200, headers: {} }),
    });
    expect(r.uploaded).toBe("original");
    expect(r.compressionError?.code).toBe("MALFORMED_INPUT");
    expect(requests[0].body).toBe(file);
    expect(requests[0].headers["Content-Type"]).toBe("image/png");
  });

  it("uploads the original when compression does not help", async () => {
    const r = await compressAndUpload(file, {
      requestPresignedUpload: async () => ({ url: "https://x/put" }),
      compress: async () => fakeResult({ outputBytes: 1200 }),
      transport: async () => ({ status: 200, headers: {} }),
    });
    expect(r.uploaded).toBe("original");
  });

  it("does not upload when aborted during compression", async () => {
    const transport = vi.fn();
    const ac = new AbortController();
    ac.abort();
    await expect(
      compressAndUpload(file, { requestPresignedUpload: async () => ({ url: "u" }), compress: async () => { throw new OptiqError("ABORTED", "a"); }, transport, signal: ac.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("supports presigned POST policies with the file as the last field", async () => {
    let body: FormData | undefined;
    await uploadToPresignedUrl(new Blob(["x"]), { url: "https://b.s3.amazonaws.com/", method: "POST", fields: { key: "k", policy: "p" } }, {
      contentType: "image/avif",
      fileName: "a.avif",
      transport: async (req) => ((body = req.body as FormData), { status: 204, headers: {} }),
    });
    const keys = [...body!.keys()];
    expect(keys).toEqual(["key", "policy", "Content-Type", "file"]);
    expect(body!.get("Content-Type")).toBe("image/avif");
  });

  it("throws UploadError on HTTP failure (the caller keeps the original file)", async () => {
    await expect(uploadToPresignedUrl(new Blob(["x"]), { url: "u" }, { contentType: "image/png", transport: async () => ({ status: 403, headers: {} }) })).rejects.toBeInstanceOf(UploadError);
  });
});
