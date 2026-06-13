import { describe, it, expect, vi, beforeEach } from "vitest";

const saveMediaBuffer = vi.fn();
vi.mock("openclaw/plugin-sdk/media-store", () => ({
  saveMediaBuffer: (...args: unknown[]) => saveMediaBuffer(...args),
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
      undefined,
      "report.pdf",
    );
    expect(out.path).toContain(".pdf");
  });

  it("works without a filename (keeps prior 4-arg-compatible behaviour)", async () => {
    saveMediaBuffer.mockResolvedValue({ id: "uuid", path: "/m/inbound/uuid" });

    const out = await saveInboundMediaBuffer(Buffer.from("x"), "image/png");

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "image/png",
      "inbound",
      undefined,
      undefined,
    );
    expect(out.id).toBe("uuid");
  });
});
