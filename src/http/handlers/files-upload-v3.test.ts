import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IdempotentUploadConflictError, storeIdempotentUpload } from "./files-upload.js";
import { clearFileIndexForTest, setAttachmentsDirForTest } from "./files.js";

const roots: string[] = [];

afterEach(() => {
  setAttachmentsDirForTest(null);
  clearFileIndexForTest();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("protocol v3 attachment uploads", () => {
  it("returns one durable file for retries and rejects reuse with changed bytes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-files-v3-"));
    roots.push(root);
    setAttachmentsDirForTest(root);
    const bytes = Buffer.from("same file");
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

    const first = storeIdempotentUpload({
      deviceId: "PHONE-1",
      clientAttachmentId: "attachment-1",
      sha256,
      buffer: bytes,
      filename: "hello.txt",
      mimeType: "text/plain",
    });
    clearFileIndexForTest();
    const replay = storeIdempotentUpload({
      deviceId: "phone-1",
      clientAttachmentId: "attachment-1",
      sha256,
      buffer: bytes,
      filename: "hello.txt",
      mimeType: "text/plain",
    });

    expect(replay.id).toBe(first.id);
    expect(replay.urlToken).toBe(first.urlToken);
    expect(() =>
      storeIdempotentUpload({
        deviceId: "PHONE-1",
        clientAttachmentId: "attachment-1",
        sha256: crypto.createHash("sha256").update("changed").digest("hex"),
        buffer: Buffer.from("changed"),
        filename: "hello.txt",
        mimeType: "text/plain",
      }),
    ).toThrow(IdempotentUploadConflictError);
  });
});
