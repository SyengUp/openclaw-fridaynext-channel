import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fridayNextChannelPlugin } from "./channel.js";
import { sseEmitter } from "./sse/emitter.js";
import { setOfflineQueueBaseDirForTest } from "./sse/offline-queue.js";
import { registerRunRoute } from "./run-metadata.js";
import { getRuntimeV3Store, setRuntimeV3RootForTest } from "./runtime-v3/runtime-store.js";
import {
  createTempHistoryDir,
  removeTempHistoryDir,
  setMockRuntime,
} from "./test-support/mock-runtime.js";
import { encryptOutboundBufferToFnoss } from "./public-access/outbound-media-oss.js";

// The OSS rewrite hits the control plane + Aliyun; stub it. Default null = public access off /
// LAN device, so the existing tunnel-URL behavior holds; one test opts in via mockResolvedValueOnce.
vi.mock("./public-access/outbound-media-oss.js", () => ({
  resolveOssOutboundConfig: vi.fn(() => null),
  deviceUsesPublicSurface: vi.fn(() => false),
  encryptOutboundBufferToFnoss: vi.fn(async () => null),
}));

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
    setRuntimeV3RootForTest(null);
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
    registerRunRoute({
      runId,
      deviceId,
      sessionKey: "agent:operator:friday-next:direct:route-session",
    });
    sseEmitter.trackDeviceForRun(deviceId, runId);
    const res = connect(deviceId);

    await outbound.sendText({
      to: deviceId,
      text: "hi",
      requesterSessionKey: "agent:operator:main",
    });

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

  it("sendText reaches a v3-only online device (no v2 connection)", async () => {
    const deviceId = "DEV-V3-ONLY";
    const runId = "run-v3-only";
    const sessionKey = "agent:operator:friday-next:direct:v3-only";
    registerRunRoute({ runId, deviceId, sessionKey });
    sseEmitter.trackDeviceForRun(deviceId, runId);

    // 1.5 App 只连 v3：v3 SSE handler 连接时仅注册 store listener，不进 v2 emitter。
    // 旧口径只查 v2 连接 → 误判离线 → 整个 broadcast 被跳过，消息在 v3 侧彻底丢失。
    setRuntimeV3RootForTest(path.join(historyDir, "runtime-v3-sendtext"));
    const store = getRuntimeV3Store();
    store.observeRun({ runId, sessionKey, agentId: "operator", deviceIds: [deviceId] });
    const received: string[] = [];
    store.subscribe(deviceId, (event) => received.push(event.eventType));

    await outbound.sendText({ to: deviceId, text: "hi from v3" });

    expect(received).toContain("outbound.text");
  });

  it("sendMedia reaches a v3-only online device (no v2 connection)", async () => {
    const deviceId = "DEV-V3-ONLY-MEDIA";
    const runId = "run-v3-only-media";
    const sessionKey = "agent:operator:friday-next:direct:v3-only-media";
    const mediaFile = path.join(historyDir, "shot-v3.png");
    fs.writeFileSync(mediaFile, "png-bytes");
    registerRunRoute({ runId, deviceId, sessionKey });
    sseEmitter.trackDeviceForRun(deviceId, runId);

    // 与 sendText 同理：v3-only 在线设备在旧口径下被判离线，media broadcast 被整段跳过。
    setRuntimeV3RootForTest(path.join(historyDir, "runtime-v3-sendmedia"));
    const store = getRuntimeV3Store();
    store.observeRun({ runId, sessionKey, agentId: "operator", deviceIds: [deviceId] });
    const received: string[] = [];
    store.subscribe(deviceId, (event) => received.push(event.eventType));

    await outbound.sendMedia({ to: deviceId, text: "caption", mediaUrl: mediaFile });

    expect(received).toContain("outbound.media");
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

    const evt = parseOutboundFrames(res).find(
      (f) => f.type === "outbound" && f.data.op === "media",
    );
    expect(evt).toBeDefined();
    expect(evt?.data.sessionKey).toBe(sessionKey);
    expect(evt?.data.deviceId).toBe(deviceId);
  });

  it("sendMedia diverts to an OSS fnoss:v1 ref when public access is on (E-wire ③)", async () => {
    const deviceId = "DEV-MEDIA-OSS";
    const runId = "run-media-oss";
    const sessionKey = "agent:operator:friday-next:direct:abc-media-oss";
    const mediaFile = path.join(historyDir, "shot.png");
    fs.writeFileSync(mediaFile, "png-bytes");
    registerRunRoute({ runId, deviceId, sessionKey });
    sseEmitter.trackDeviceForRun(deviceId, runId);
    const res = connect(deviceId);

    const fnossURI = "fnoss:v1:VEVTVFJFRg";
    vi.mocked(encryptOutboundBufferToFnoss).mockResolvedValueOnce(fnossURI);

    await outbound.sendMedia({ to: deviceId, text: "caption", mediaUrl: mediaFile });

    const evt = parseOutboundFrames(res).find(
      (f) => f.type === "outbound" && f.data.op === "media",
    );
    expect(evt).toBeDefined();
    expect(evt?.data.mediaUrl).toBe(fnossURI);
    expect(String(evt?.data.mediaUrl)).not.toMatch(/^\/friday-next\/files\//);
    expect(vi.mocked(encryptOutboundBufferToFnoss)).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ mime: expect.any(String) }),
      "DEV-MEDIA-OSS",
    );
  });
});
