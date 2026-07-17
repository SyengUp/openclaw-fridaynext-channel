import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMessageAction } from "./channel-actions.js";
import { sseEmitter } from "./sse/emitter.js";
import { setOfflineQueueBaseDirForTest } from "./sse/offline-queue.js";
import { registerRunRoute } from "./run-metadata.js";
import {
  fridayNotificationsStore,
  setNotificationsBaseDirForTest,
} from "./notifications/notifications-store.js";
import {
  createTempHistoryDir,
  removeTempHistoryDir,
  setMockRuntime,
} from "./test-support/mock-runtime.js";
import {
  noteCronActivity,
  resetCronNotificationTrackerForTest,
} from "./notifications/cron-notification-tracker.js";
import { resetHeartbeatNotificationTrackerForTest } from "./notifications/heartbeat-notification-tracker.js";
import { encryptOutboundBufferToFnoss } from "./public-access/outbound-media-oss.js";

// The OSS rewrite hits the control plane + Aliyun; stub it. Default null = public access off, so the
// existing `/friday-next/files/…` tunnel-URL assertions hold; one test opts in via mockResolvedValueOnce.
vi.mock("./public-access/outbound-media-oss.js", () => ({
  resolveOssOutboundConfig: vi.fn(() => null),
  encryptOutboundBufferToFnoss: vi.fn(async () => null),
}));

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
    vi.unstubAllGlobals();
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

  it("send media via an https `url` direct link downloads it and emits op:media", async () => {
    const deviceId = "DEV-ACT-URL";
    const runId = "run-act-url";
    const appSession = "agent:operator:friday:direct:dev-act-url:1780561609";
    registerRunRoute({ runId, deviceId, sessionKey: appSession });
    sseEmitter.trackDeviceForRun(deviceId, runId);
    const res = connect(deviceId);

    // 8-byte PNG magic header so saveMediaBuffer's magic-byte detection recognizes an image.
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const directLink = "https://picsum.photos/600/400";
    const fetchMock = vi.fn(
      async () => new Response(pngBytes, { status: 200, headers: { "content-type": "image/png" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleMessageAction({
      action: "send",
      // The agent sends a direct link via the `url` param, not `media`.
      params: { to: deviceId, message: "直链图来了", url: directLink },
      sessionKey: "agent:operator:main",
    });

    expect((result as { ok?: boolean }).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(directLink, expect.anything());

    const frames = parseOutboundFrames(res);
    const media = frames.find((f) => f.type === "outbound" && f.data.op === "media");
    expect(media).toBeTruthy();
    expect(String(media?.data.mediaUrl)).toMatch(/^\/friday-next\/files\//);
    expect((media?.data.ctx as { originalMediaUrl?: string })?.originalMediaUrl).toBe(directLink);
    expect(media?.data.sessionKey).toBe(appSession);
  });

  it("send media via an inline base64 `buffer` param decodes it and emits op:media", async () => {
    const deviceId = "DEV-ACT-BUF";
    const runId = "run-act-buf";
    const appSession = "agent:operator:friday:direct:dev-act-buf:1780561609";
    registerRunRoute({ runId, deviceId, sessionKey: appSession });
    sseEmitter.trackDeviceForRun(deviceId, runId);
    const res = connect(deviceId);

    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    const result = await handleMessageAction({
      action: "send",
      params: {
        to: deviceId,
        message: "base64 图来了",
        buffer: jpegBytes.toString("base64"),
        mimeType: "image/jpeg",
        filename: "test-small.jpg",
      },
      sessionKey: "agent:operator:main",
    });

    expect((result as { ok?: boolean }).ok).toBe(true);
    const frames = parseOutboundFrames(res);
    const media = frames.find((f) => f.type === "outbound" && f.data.op === "media");
    expect(media).toBeTruthy();
    expect(String(media?.data.mediaUrl)).toMatch(/^\/friday-next\/files\//);
    expect((media?.data.ctx as { originalMediaUrl?: string })?.originalMediaUrl).toBe(
      "test-small.jpg",
    );
    expect(media?.data.sessionKey).toBe(appSession);
  });

  it("send media diverts to an OSS fnoss:v1 ref when public access is on (E-wire ③)", async () => {
    const deviceId = "DEV-ACT-OSS";
    const runId = "run-act-oss";
    const appSession = "agent:operator:friday:direct:dev-act-oss:1780561609";
    registerRunRoute({ runId, deviceId, sessionKey: appSession });
    sseEmitter.trackDeviceForRun(deviceId, runId);
    const res = connect(deviceId);

    // Public access on → the OSS rewrite returns a fnoss ref; the tunnel URL must be replaced by it.
    const fnossURI = "fnoss:v1:VEVTVFJFRg";
    vi.mocked(encryptOutboundBufferToFnoss).mockResolvedValueOnce(fnossURI);

    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const result = await handleMessageAction({
      action: "send",
      params: {
        to: deviceId,
        message: "OSS 图来了",
        buffer: jpegBytes.toString("base64"),
        mimeType: "image/jpeg",
        filename: "oss.jpg",
      },
      sessionKey: "agent:operator:main",
    });

    expect((result as { ok?: boolean }).ok).toBe(true);
    const frames = parseOutboundFrames(res);
    const media = frames.find((f) => f.type === "outbound" && f.data.op === "media");
    expect(media).toBeTruthy();
    expect(media?.data.mediaUrl).toBe(fnossURI);
    expect(String(media?.data.mediaUrl)).not.toMatch(/^\/friday-next\/files\//);
    expect(vi.mocked(encryptOutboundBufferToFnoss)).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ mime: "image/jpeg" }),
    );
  });

  it("send with a multi-file mediaUrls[] emits one op:media per file (same runId)", async () => {
    // The agent's `message` tool call with a structured `attachments[]` array is flattened by the
    // OpenClaw core into `params.mediaUrls` (with `media` set to the first entry for back-compat).
    // handleSend must emit one outbound op:media per file, not just the first.
    const deviceId = "DEV-ACT-MULTI";
    const runId = "run-act-multi";
    const appSession = "agent:operator:friday:direct:dev-act-multi:1780561609";
    registerRunRoute({ runId, deviceId, sessionKey: appSession });
    sseEmitter.trackDeviceForRun(deviceId, runId);
    const res = connect(deviceId);

    const files = ["A.swift", "B.swift", "C.swift"].map((name) => {
      const p = path.join(historyDir, name);
      fs.writeFileSync(p, `// ${name}`);
      return p;
    });

    const result = await handleMessageAction({
      action: "send",
      params: {
        to: deviceId,
        message: "三个文件发给你",
        media: files[0], // core sets `media` to the first entry
        mediaUrls: files, // ...and the full list here
      },
      sessionKey: "agent:operator:main",
    });

    expect((result as { ok?: boolean }).ok).toBe(true);
    const mediaFrames = parseOutboundFrames(res).filter(
      (f) => f.type === "outbound" && f.data.op === "media",
    );
    expect(mediaFrames).toHaveLength(3);
    // All media events share the send's runId so the app groups them into one assistant message.
    const runIds = new Set(mediaFrames.map((f) => f.data.runId));
    expect(runIds.size).toBe(1);
    // Original filenames preserved (one per file, no duplicates, no drops).
    const names = mediaFrames
      .map((f) => (f.data.ctx as { originalMediaUrl?: string })?.originalMediaUrl)
      .map((p) => (p ? path.basename(p) : ""));
    expect(new Set(names)).toEqual(new Set(["A.swift", "B.swift", "C.swift"]));
    for (const f of mediaFrames) {
      expect(String(f.data.mediaUrl)).toMatch(/^\/friday-next\/files\//);
      expect(f.data.sessionKey).toBe(appSession);
    }
  });

  it("falls back to ctx.sessionKey when the device has no active run-route", async () => {
    const deviceId = "DEV-ACT-2";
    const res = connect(deviceId);

    await handleMessageAction({
      action: "send",
      params: { to: deviceId, message: "hi" },
      sessionKey: "agent:operator:friday:direct:fallback-session",
    });

    const text = parseOutboundFrames(res).find(
      (f) => f.type === "outbound" && f.data.op === "text",
    );
    expect(text?.data.sessionKey).toBe("agent:operator:friday:direct:fallback-session");
  });
});

/**
 * The `message`-tool path (handleAction → handleSend) must also feed the durable notification store,
 * mirroring outbound.sendText. Without this a cron push that the agent delivers via the message tool
 * is captured nowhere and the app never surfaces it (the original "科技要闻" bug).
 */
describe("channel-actions handleSend notification capture", () => {
  let historyDir = "";

  beforeEach(() => {
    sseEmitter.resetForTest();
    resetCronNotificationTrackerForTest();
    resetHeartbeatNotificationTrackerForTest();
    historyDir = createTempHistoryDir();
    setOfflineQueueBaseDirForTest(historyDir);
    setMockRuntime({ historyDir, authToken: "test-token" });
    setNotificationsBaseDirForTest(path.join(historyDir, "notifications"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetCronNotificationTrackerForTest();
    resetHeartbeatNotificationTrackerForTest();
    setOfflineQueueBaseDirForTest(null);
    setNotificationsBaseDirForTest(null);
    removeTempHistoryDir(historyDir);
  });

  function connect(deviceId: string): MockRes {
    const res = new MockRes();
    sseEmitter.addConnection(deviceId, res as never);
    return res;
  }

  it("captures a cron message-tool send as a 'cron' notification even when a user run-route masks the delivery key", async () => {
    // This is the core fix: the agent's cron run calls the message tool; ctx.sessionKey is the cron
    // origin key, but the delivery-routing sessionKey gets overwritten by the device's last user run
    // (attachment placement). Classification must use ctx.sessionKey so the cron origin survives.
    const deviceId = "DEV-CRON-1";
    const runId = "run-user-stale";
    const userSession = "agent:main:fridaynext:userabc";
    registerRunRoute({ runId, deviceId, sessionKey: userSession });
    sseEmitter.trackDeviceForRun(deviceId, runId);
    // device offline — the classic cron-while-app-backgrounded case

    await handleMessageAction({
      action: "send",
      params: { to: deviceId, message: "🌿 早安，周六科技要闻来了" },
      sessionKey: "agent:main:cron:job-xyz:run:abc",
    });

    const notes = fridayNotificationsStore.readAfter(deviceId, 0);
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("cron");
    expect(notes[0].text).toBe("🌿 早安，周六科技要闻来了");
    expect(notes[0].hasMedia).toBe(false);
  });

  // Regression (lost 23:00 每日趣闻汇总): the agent delivered the cron via the message tool while the
  // device was mid-reconnect (getConnection reports "online" but the app never got the live push),
  // AND ctx.sessionKey carried no cron marker. It must STILL be captured — via the cron tracker — so
  // the inbox holds a durable record.
  it("captures an online message-tool send when a cron fired recently, even with an unclassified key", async () => {
    const deviceId = "DEV-FLAP-CRON";
    connect(deviceId); // "online" during a connection flap
    noteCronActivity("job-趣闻", "每日趣闻汇总");

    await handleMessageAction({
      action: "send",
      params: { to: deviceId, message: "🌙 已发送深夜趣闻" },
      sessionKey: "agent:main:main", // marker-less origin (isolated cron ran under base session)
    });

    const notes = fridayNotificationsStore.readAfter(deviceId, 0) as Array<{
      kind: string;
      jobName?: string;
    }>;
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("cron");
    expect(notes[0].jobName).toBe("每日趣闻汇总");
  });

  it("captures an offline message-tool send as a generic 'push' even without a cron key", async () => {
    const deviceId = "DEV-OFF-1";
    // offline, non-cron origin → fallbackKind "push" keeps it from being silently lost

    await handleMessageAction({
      action: "send",
      params: { to: deviceId, message: "background ping" },
      sessionKey: "agent:main:fridaynext:normal",
    });

    const notes = fridayNotificationsStore.readAfter(deviceId, 0);
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("push");
  });

  it("does NOT capture a normal online reply (non-background, device connected)", async () => {
    const deviceId = "DEV-NORM-1";
    connect(deviceId); // online → fallbackKind null, non-cron key → classify null → ignored

    await handleMessageAction({
      action: "send",
      params: { to: deviceId, message: "hi there" },
      sessionKey: "agent:main:fridaynext:normal",
    });

    expect(fridayNotificationsStore.readAfter(deviceId, 0)).toHaveLength(0);
  });

  it("resolves a bare 'friday-next' channel target to the real device, not a FRIDAY-NEXT key", async () => {
    // Agents often pass the channel name as the message-tool target instead of a device id.
    // handleSend must resolve it to the real device so the notification lands where the app
    // (which queries by its own deviceId) will actually fetch it.
    const deviceId = "DEV-RESOLVE-1";
    connect(deviceId); // sole connected → resolveFridayDeviceIdForOutbound maps "friday-next" here

    await handleMessageAction({
      action: "send",
      params: { to: "friday-next", message: "频道名目标应落到真实设备" },
      sessionKey: "agent:main:cron:job-res:run:r1",
    });

    expect(fridayNotificationsStore.readAfter(deviceId, 0)).toHaveLength(1);
    expect(fridayNotificationsStore.readAfter(deviceId, 0)[0].kind).toBe("cron");
    // Crucially NOT keyed under the non-device channel name.
    expect(fridayNotificationsStore.readAfter("FRIDAY-NEXT", 0)).toHaveLength(0);
  });

  it("captures a cron media send with hasMedia=true", async () => {
    const deviceId = "DEV-CRON-MEDIA";
    const mediaFile = path.join(historyDir, "chart.png");
    fs.writeFileSync(mediaFile, "png-bytes");

    await handleMessageAction({
      action: "send",
      params: { to: deviceId, message: "今日走势", media: mediaFile },
      sessionKey: "agent:main:cron:job-media:run:m1",
    });

    const notes = fridayNotificationsStore.readAfter(deviceId, 0);
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("cron");
    expect(notes[0].hasMedia).toBe(true);
    expect(notes[0].text).toBe("今日走势");
  });
});
