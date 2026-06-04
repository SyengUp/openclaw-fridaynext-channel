import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleMessageAction } from "./channel-actions.js";
import { sseEmitter } from "./sse/emitter.js";
import { setOfflineQueueBaseDirForTest } from "./sse/offline-queue.js";
import { registerRunRoute } from "./run-metadata.js";
import { createTempHistoryDir, removeTempHistoryDir, setMockRuntime } from "./test-support/mock-runtime.js";

/**
 * The `message` tool's `action=send` is handled here (NOT via outbound.sendText/sendMedia).
 * `ctx.sessionKey` is the agent's base/main session, so the send must recover the app session that
 * started the device's active run from the run-route registry — otherwise attachments land in a
 * device-level / main session instead of the user's current session.
 */

class MockRes extends EventEmitter {
  writes: string[] = [];
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
  end(): void {
    // no-op
  }
}

type OutboundFrame = { type: string; data: Record<string, unknown> };

function parseOutboundFrames(res: MockRes): OutboundFrame[] {
  const frames: OutboundFrame[] = [];
  for (const block of res.writes.join("").split("\n\n")) {
    if (!block.trim()) continue;
    let type = "";
    let data: Record<string, unknown> | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) type = line.slice("event: ".length).trim();
      else if (line.startsWith("data: ")) {
        try {
          data = JSON.parse(line.slice("data: ".length));
        } catch {
          // ignore
        }
      }
    }
    if (data) frames.push({ type, data });
  }
  return frames;
}

describe("channel-actions handleSend sessionKey routing", () => {
  let historyDir = "";

  beforeEach(() => {
    sseEmitter.resetForTest();
    historyDir = createTempHistoryDir();
    setOfflineQueueBaseDirForTest(historyDir);
    setMockRuntime({ historyDir, authToken: "test-token" });
  });

  afterEach(() => {
    setOfflineQueueBaseDirForTest(null);
    removeTempHistoryDir(historyDir);
  });

  function connect(deviceId: string): MockRes {
    const res = new MockRes();
    sseEmitter.addConnection(deviceId, res as never);
    return res;
  }

  it("send media routes to the active run's app session, not ctx.sessionKey", async () => {
    const deviceId = "DEV-ACT-1";
    const runId = "run-act-1";
    const appSession = "agent:operator:friday:direct:dev-act-1:1780561609";
    const mediaFile = path.join(historyDir, "shot.png");
    fs.writeFileSync(mediaFile, "png-bytes");
    registerRunRoute({ runId, deviceId, sessionKey: appSession });
    sseEmitter.trackDeviceForRun(deviceId, runId);
    const res = connect(deviceId);

    const result = await handleMessageAction({
      action: "send",
      params: { to: deviceId, message: "桌面截图来了 📸", media: mediaFile },
      sessionKey: "agent:operator:main", // ctx gives the base/main session — must be overridden
    });

    expect((result as { ok?: boolean }).ok).toBe(true);
    const frames = parseOutboundFrames(res);
    const media = frames.find((f) => f.type === "outbound" && f.data.op === "media");
    const text = frames.find((f) => f.type === "outbound" && f.data.op === "text");
    expect(media?.data.sessionKey).toBe(appSession);
    expect(text?.data.sessionKey).toBe(appSession);
    expect(media?.data.deviceId).toBe(deviceId);
  });

  it("falls back to ctx.sessionKey when the device has no active run-route", async () => {
    const deviceId = "DEV-ACT-2";
    const res = connect(deviceId);

    await handleMessageAction({
      action: "send",
      params: { to: deviceId, message: "hi" },
      sessionKey: "agent:operator:friday:direct:fallback-session",
    });

    const text = parseOutboundFrames(res).find((f) => f.type === "outbound" && f.data.op === "text");
    expect(text?.data.sessionKey).toBe("agent:operator:friday:direct:fallback-session");
  });
});
