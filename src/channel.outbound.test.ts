import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fridayNextChannelPlugin } from "./channel.js";
import { sseEmitter } from "./sse/emitter.js";
import { setOfflineQueueBaseDirForTest } from "./sse/offline-queue.js";
import { registerRunRoute } from "./run-metadata.js";
import { createTempHistoryDir, removeTempHistoryDir, setMockRuntime } from "./test-support/mock-runtime.js";

/**
 * Outbound (message-tool send) must route to the session that started the run.
 *
 * OpenClaw's `ChannelOutboundContext` does not carry the originating sessionKey, so the channel
 * recovers it from the run-route registry via the device's last tracked runId. Without this the
 * media/text would land in a device-level fallback session, not the user's current session.
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
          // ignore non-JSON
        }
      }
    }
    if (data) frames.push({ type, data });
  }
  return frames;
}

const outbound = fridayNextChannelPlugin.outbound as {
  sendText: (ctx: Record<string, unknown>) => Promise<unknown>;
  sendMedia: (ctx: Record<string, unknown>) => Promise<unknown>;
};

describe("friday-next channel outbound sessionKey routing", () => {
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

  it("sendText carries the run's sessionKey (recovered via run-route)", async () => {
    const deviceId = "DEV-TEXT-1";
    const runId = "run-text-1";
    const sessionKey = "agent:operator:friday-next:direct:abc-text";
    registerRunRoute({ runId, deviceId, sessionKey });
    sseEmitter.trackDeviceForRun(deviceId, runId);
    const res = connect(deviceId);

    await outbound.sendText({ to: deviceId, text: "hi" });

    const evt = parseOutboundFrames(res).find((f) => f.type === "outbound" && f.data.op === "text");
    expect(evt).toBeDefined();
    expect(evt?.data.sessionKey).toBe(sessionKey);
    expect(evt?.data.deviceId).toBe(deviceId);
  });

  it("run-route wins over ctx sessionKey (ctx carries the agent's base/main session, not the active app session)", async () => {
    const deviceId = "DEV-TEXT-2";
    const runId = "run-text-2";
    registerRunRoute({ runId, deviceId, sessionKey: "agent:operator:friday-next:direct:route-session" });
    sseEmitter.trackDeviceForRun(deviceId, runId);
    const res = connect(deviceId);

    await outbound.sendText({ to: deviceId, text: "hi", requesterSessionKey: "agent:operator:main" });

    const evt = parseOutboundFrames(res).find((f) => f.type === "outbound" && f.data.op === "text");
    expect(evt?.data.sessionKey).toBe("agent:operator:friday-next:direct:route-session");
  });

  it("falls back to device-level session when no run-route exists", async () => {
    const deviceId = "DEV-TEXT-3";
    sseEmitter.trackDeviceForRun(deviceId, "run-text-3-untracked");
    const res = connect(deviceId);

    await outbound.sendText({ to: deviceId, text: "hi" });

    const evt = parseOutboundFrames(res).find((f) => f.type === "outbound" && f.data.op === "text");
    // No mapping registered for this device → synthesized device-level fallback.
    expect(evt?.data.sessionKey).toBe(`agent:main:friday-next-${deviceId}`);
  });

  it("sendMedia carries the run's sessionKey (recovered via run-route)", async () => {
    const deviceId = "DEV-MEDIA-1";
    const runId = "run-media-1";
    const sessionKey = "agent:operator:friday-next:direct:abc-media";
    const mediaFile = path.join(historyDir, "shot.png");
    fs.writeFileSync(mediaFile, "png-bytes");
    registerRunRoute({ runId, deviceId, sessionKey });
    sseEmitter.trackDeviceForRun(deviceId, runId);
    const res = connect(deviceId);

    await outbound.sendMedia({ to: deviceId, text: "caption", mediaUrl: mediaFile });

    const evt = parseOutboundFrames(res).find((f) => f.type === "outbound" && f.data.op === "media");
    expect(evt).toBeDefined();
    expect(evt?.data.sessionKey).toBe(sessionKey);
    expect(evt?.data.deviceId).toBe(deviceId);
  });
});
