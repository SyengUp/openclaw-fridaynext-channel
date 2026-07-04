import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fridayNextChannelPlugin } from "./channel.js";
import { sseEmitter } from "./sse/emitter.js";
import { setNotificationsBaseDirForTest } from "./notifications/notifications-store.js";
import {
  noteCronActivity,
  resetCronNotificationTrackerForTest,
} from "./notifications/cron-notification-tracker.js";
import { resetHeartbeatNotificationTrackerForTest } from "./notifications/heartbeat-notification-tracker.js";

/**
 * Real cron deliveries reach sendText with a device/history session key — never `agent:…:cron:…`
 * (the core's ChannelOutboundContext carries no origin identity), so key classification alone
 * misses them and an offline device would silently lose the push. sendText/sendMedia must capture
 * any send that could NOT be delivered live (no SSE connection) as a "push" notification, while
 * online sends with unclassified keys stay un-captured (they reach the app live via SSE).
 */

class MockRes extends EventEmitter {
  write(): boolean {
    return true;
  }
  end(): void {
    // no-op
  }
}

const outbound = fridayNextChannelPlugin.outbound as {
  sendText: (ctx: Record<string, unknown>) => Promise<unknown>;
};

function readNotifications(dir: string, deviceId: string): Array<{ kind: string; text: string }> {
  const file = path.join(dir, `${deviceId.toUpperCase()}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { kind: string; text: string });
}

describe("friday-next offline push notification capture", () => {
  let notifDir = "";

  beforeEach(() => {
    sseEmitter.resetForTest();
    resetCronNotificationTrackerForTest();
    resetHeartbeatNotificationTrackerForTest();
    notifDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-notif-offline-"));
    setNotificationsBaseDirForTest(notifDir);
  });

  afterEach(() => {
    setNotificationsBaseDirForTest(null);
    resetCronNotificationTrackerForTest();
    resetHeartbeatNotificationTrackerForTest();
    fs.rmSync(notifDir, { recursive: true, force: true });
  });

  it("captures an offline cron-style sendText as a 'push' notification", async () => {
    const deviceId = "DEV-OFFLINE-CRON";
    // No SSE connection, no run route → sessionKey resolves to the device history
    // fallback (unclassifiable) — exactly what a real cron delivery looks like.
    await outbound.sendText({ to: deviceId, text: "早上好,这是定时问候" });

    const entries = readNotifications(notifDir, deviceId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("push");
    expect(entries[0]?.text).toBe("早上好,这是定时问候");
  });

  it("does NOT capture an online sendText with an unclassified session key", async () => {
    const deviceId = "DEV-ONLINE-REPLY";
    sseEmitter.addConnection(deviceId, new MockRes() as never);

    await outbound.sendText({ to: deviceId, text: "普通在线回复" });

    expect(readNotifications(notifDir, deviceId)).toHaveLength(0);
  });

  it("still captures classified cron session keys even when the device is online", async () => {
    const deviceId = "DEV-ONLINE-CRON";
    sseEmitter.addConnection(deviceId, new MockRes() as never);

    await outbound.sendText({
      to: deviceId,
      text: "定时巡检",
      requesterSessionKey: "agent:main:cron:patrol:run:r1",
    });

    const entries = readNotifications(notifDir, deviceId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("cron");
  });

  // Regression (lost 23:00 每日趣闻汇总): an ONLINE send whose session key carries NO cron marker
  // but which correlates to a recently-fired cron (tracker) MUST still be captured durably — a
  // connection flap can make getConnection report "online" while the app never receives the live
  // push, and the inbox is the only durable record.
  it("captures an online unclassified send when a cron fired recently (tracker)", async () => {
    const deviceId = "DEV-ONLINE-FLAP-CRON";
    sseEmitter.addConnection(deviceId, new MockRes() as never);
    noteCronActivity("job-趣闻", "每日趣闻汇总");

    await outbound.sendText({ to: deviceId, text: "🌙 深夜趣闻汇总" });

    const entries = readNotifications(notifDir, deviceId) as Array<{
      kind: string;
      text: string;
      jobName?: string;
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("cron");
    expect(entries[0]?.jobName).toBe("每日趣闻汇总");
  });
});
