import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearFileIndexForTest,
  fridayFilesPublicUrl,
  readAttachmentFileFromDisk,
  rememberInboundMediaName,
  resolveMediaAttachment,
  setAttachmentsDirForTest,
  storeFile,
} from "./files.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fn-files-"));
  setAttachmentsDirForTest(tmpDir);
  clearFileIndexForTest();
});

afterEach(() => {
  setAttachmentsDirForTest(null);
  clearFileIndexForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("attachment original filename survives a gateway restart", () => {
  it("stores under a uuid token but recovers the original filename from disk", () => {
    const stored = storeFile(
      Buffer.from("%PDF-1.4 fake"),
      "Quarterly Report.pdf",
      "application/pdf",
    );
    expect(stored.urlToken).not.toBe("Quarterly Report.pdf");

    const disk = readAttachmentFileFromDisk(stored.urlToken);
    expect(disk).not.toBeNull();
    // The display/download name is the original — not the on-disk uuid.
    expect(disk!.filename).toBe("Quarterly Report.pdf");
    expect(disk!.mimeType).toBe("application/pdf");
    // The disk basename stays the uuid token so URLs keep pointing at the real file.
    expect(disk!.diskName).toBe(stored.urlToken);
  });

  it("resolveMediaAttachment keeps the original name after the in-memory index is cleared", () => {
    const stored = storeFile(Buffer.from("notes body"), "meeting-notes.txt", "text/plain");
    const url = `/friday-next/files/${encodeURIComponent(stored.urlToken)}`;

    // Simulate a gateway restart: the in-memory index is gone, only disk remains.
    clearFileIndexForTest();

    const resolved = resolveMediaAttachment(url);
    expect(resolved).not.toBeNull();
    expect(resolved!.fileName).toBe("meeting-notes.txt");
    expect(resolved!.url).toBe(url);
  });

  it("fridayFilesPublicUrl still points at the on-disk token after a restart", () => {
    const stored = storeFile(Buffer.from("x"), "doc.docx", "application/octet-stream");
    clearFileIndexForTest();

    const publicUrl = fridayFilesPublicUrl(
      `/friday-next/files/${encodeURIComponent(stored.urlToken)}`,
    );
    expect(publicUrl).toBe(`/friday-next/files/${encodeURIComponent(stored.urlToken)}`);
  });

  it("falls back to the on-disk basename for legacy files that have no sidecar", () => {
    // A file stored before this fix: raw uuid token on disk, no .fnmeta sidecar.
    const token = "11111111-2222-3333-4444-555555555555.pdf";
    fs.writeFileSync(path.join(tmpDir, token), Buffer.from("legacy"));

    const disk = readAttachmentFileFromDisk(token);
    expect(disk).not.toBeNull();
    expect(disk!.filename).toBe(token);
    expect(disk!.diskName).toBe(token);
  });

  it("never serves the sidecar file itself", () => {
    const stored = storeFile(Buffer.from("y"), "report.pdf", "application/pdf");
    expect(readAttachmentFileFromDisk(`${stored.urlToken}.fnmeta`)).toBeNull();
  });
});

describe("inbound user attachments (core media-store renames to a bare uuid)", () => {
  it("recovers the original upload name from the remembered inbound sidecar on rebuild", () => {
    // Core copies the upload to media/inbound/<uuid> with no extension and no name;
    // the transcript records this path. We remembered the real name at send time.
    const inboundUuid = "c950d280-55e5-4e06-aede-9f08653362a8";
    const inboundPath = path.join(tmpDir, "..", "media", "inbound", inboundUuid);
    fs.mkdirSync(path.dirname(inboundPath), { recursive: true });
    fs.writeFileSync(inboundPath, Buffer.from("%PDF body"));

    rememberInboundMediaName(inboundPath, "Project Brief.pdf", "application/pdf");

    // History rebuild: resolveMediaAttachment is handed the raw inbound path.
    const resolved = resolveMediaAttachment(inboundPath);
    expect(resolved).not.toBeNull();
    expect(resolved!.fileName).toBe("Project Brief.pdf");
    // The copy carries the recovered extension so downloads open correctly.
    expect(resolved!.url).toMatch(/\.pdf$/);

    fs.rmSync(path.dirname(inboundPath), { recursive: true, force: true });
  });

  it("falls back to the bare uuid when nothing was remembered (pre-fix messages)", () => {
    const inboundUuid = "99999999-0000-1111-2222-333333333333";
    const inboundPath = path.join(tmpDir, "..", "media", "inbound", inboundUuid);
    fs.mkdirSync(path.dirname(inboundPath), { recursive: true });
    fs.writeFileSync(inboundPath, Buffer.from("legacy"));

    const resolved = resolveMediaAttachment(inboundPath);
    expect(resolved).not.toBeNull();
    expect(resolved!.fileName).toBe(inboundUuid);

    fs.rmSync(path.dirname(inboundPath), { recursive: true, force: true });
  });
});

describe("duplicate media dedup (same source resolved twice)", () => {
  let srcDir: string;

  beforeEach(() => {
    srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "fn-src-"));
  });
  afterEach(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  it("resolving the same generated image twice reuses one attachment url", () => {
    // Repro: core hands the same generated image in as both `mediaUrl` and `mediaUrls[0]`,
    // so `resolveMediaAttachment` ran twice on the same path and minted two uuids → the app
    // rendered a duplicate primary + extra image.
    const src = path.join(srcDir, "ig_generated.png");
    fs.writeFileSync(src, Buffer.from("PNG-bytes-one-generated-image"));

    const first = resolveMediaAttachment(src);
    const second = resolveMediaAttachment(src);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.url).toBe(first!.url);
  });

  it("re-copies when a reused path holds genuinely different bytes", () => {
    const src = path.join(srcDir, "reused.png");
    fs.writeFileSync(src, Buffer.from("v1"));
    const first = resolveMediaAttachment(src);

    fs.writeFileSync(src, Buffer.from("v2-different-size"));
    const second = resolveMediaAttachment(src);

    expect(second!.url).not.toBe(first!.url);
  });
});
