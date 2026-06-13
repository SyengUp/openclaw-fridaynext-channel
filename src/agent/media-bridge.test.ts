import { describe, it, expect, vi, beforeEach } from "vitest";

const saveMediaBuffer = vi.fn();
vi.mock("openclaw/plugin-sdk/media-store", () => ({
  saveMediaBuffer: (...args: unknown[]) => saveMediaBuffer(...args),
}));

const IMAGE_MAX = 6 * 1024 * 1024;
const DOCUMENT_MAX = 100 * 1024 * 1024;
vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  mediaKindFromMime: (mime?: string) => (mime?.startsWith("image/") ? "image" : "document"),
  maxBytesForKind: (kind: string) => (kind === "image" ? IMAGE_MAX : DOCUMENT_MAX),
}));

import { saveInboundMediaBuffer } from "./media-bridge.js";

describe("saveInboundMediaBuffer", () => {
  beforeEach(() => {
    saveMediaBuffer.mockReset();
  });

  it("forwards the original filename so core preserves name+extension", async () => {
    // Without the filename, core's media-store saves inbound media as a bare uuid
    // (no extension) and the agent sees `[media attached: file://.../inbound/<uuid>]`
    // with zero file-format signal. Passing originalFilename (5th arg) restores it.
    saveMediaBuffer.mockResolvedValue({
      id: "report---uuid.pdf",
      path: "/m/inbound/report---uuid.pdf",
    });

    const out = await saveInboundMediaBuffer(Buffer.from("x"), "application/pdf", "report.pdf");

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "application/pdf",
      "inbound",
      DOCUMENT_MAX,
      "report.pdf",
    );
    expect(out.path).toContain(".pdf");
  });

  it("uses openclaw's per-kind byte cap instead of the 5MB save default", async () => {
    saveMediaBuffer.mockResolvedValue({ id: "uuid.png", path: "/m/inbound/uuid.png" });

    await saveInboundMediaBuffer(Buffer.from("x"), "image/png", "photo.png");

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "image/png",
      "inbound",
      IMAGE_MAX,
      "photo.png",
    );
  });

  it("works without a filename (still applies the per-kind cap)", async () => {
    saveMediaBuffer.mockResolvedValue({ id: "uuid", path: "/m/inbound/uuid" });

    const out = await saveInboundMediaBuffer(Buffer.from("x"), "image/png");

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "image/png",
      "inbound",
      IMAGE_MAX,
      undefined,
    );
    expect(out.id).toBe("uuid");
  });
});
