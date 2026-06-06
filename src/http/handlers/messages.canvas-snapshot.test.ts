import { describe, expect, it } from "vitest";
import { isCanvasSnapshotMediaPath, translateDeliverPayload } from "./messages.js";

/**
 * canvas.snapshot tool results are an agent-facing capture. OpenClaw core surfaces image tool
 * results as deliverable media on the assistant reply block, which would otherwise auto-attach the
 * snapshot to the user's stream. translateDeliverPayload must drop snapshot temp files (by basename)
 * while preserving the assistant text and any non-snapshot media.
 */
describe("canvas snapshot media suppression", () => {
  it("detects canvas snapshot temp paths by basename", () => {
    expect(
      isCanvasSnapshotMediaPath("/tmp/openclaw/openclaw-canvas-snapshot-d2e6aef2-0441.jpg"),
    ).toBe(true);
    expect(isCanvasSnapshotMediaPath("C:\\tmp\\openclaw-canvas-snapshot-abc.png")).toBe(true);
    expect(isCanvasSnapshotMediaPath("/Users/me/Pictures/screenshot_latest.jpg")).toBe(false);
    expect(isCanvasSnapshotMediaPath("/friday-next/files/uuid.jpg")).toBe(false);
    expect(isCanvasSnapshotMediaPath(undefined)).toBe(false);
  });

  it("strips a snapshot mediaUrl from a block deliver payload, keeping the text", () => {
    const out = translateDeliverPayload(
      {
        text: "🎉 通了!",
        mediaUrl: "/tmp/openclaw/openclaw-canvas-snapshot-d2e6aef2-0441.jpg",
      },
      "block",
    );
    expect(out.text).toBe("🎉 通了!");
    expect(out.mediaUrl).toBeNull();
    // No media survived → no image mediaKind tagged onto the payload.
    const channelData = out.channelData as { fridayNext?: { mediaKind?: string } } | undefined;
    expect(channelData?.fridayNext?.mediaKind).toBeUndefined();
  });

  it("strips snapshot entries from mediaUrls but preserves non-snapshot media", () => {
    const out = translateDeliverPayload(
      {
        text: "page rendered",
        mediaUrls: [
          "/tmp/openclaw/openclaw-canvas-snapshot-aaa.jpg",
          "/Users/me/Pictures/real-image.png",
        ],
      },
      "block",
    );
    const urls = out.mediaUrls as string[];
    expect(urls).toHaveLength(1);
    expect(urls.some((u) => u.includes("canvas-snapshot-"))).toBe(false);
  });
});
