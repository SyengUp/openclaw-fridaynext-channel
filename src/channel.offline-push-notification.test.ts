import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fridayNextChannelPlugin } from "./channel.js";
import {
  noteCronActivity,
  resetCronNotificationTrackerForTest,
} from "./notifications/cron-notification-tracker.js";
import {
  noteHeartbeatActivity,
  resetHeartbeatNotificationTrackerForTest,
} from "./notifications/heartbeat-notification-tracker.js";
import { setNotificationsBaseDirForTest } from "./notifications/notifications-store.js";
import { sseEmitter } from "./sse/emitter.js";

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

function readLegacyNotifications(dir: string, deviceId: string): unknown[] {
  const file = path.join(dir, `${deviceId.toUpperCase()}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown);
}

describe("friday-next outbound 不参与收件箱分类", () => {
  let notificationDir = "";

  beforeEach(() => {
    sseEmitter.resetForTest();
    resetCronNotificationTrackerForTest();
    resetHeartbeatNotificationTrackerForTest();
    notificationDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-notif-offline-"));
    setNotificationsBaseDirForTest(notificationDir);
  });

  afterEach(() => {
    setNotificationsBaseDirForTest(null);
    resetCronNotificationTrackerForTest();
    resetHeartbeatNotificationTrackerForTest();
    fs.rmSync(notificationDir, { recursive: true, force: true });
  });

  it("普通离线 push 不写入旧通知日志", async () => {
    const deviceId = "DEV-OFFLINE-PUSH";
    await outbound.sendText({ to: deviceId, text: "后台普通消息" });
    expect(readLegacyNotifications(notificationDir, deviceId)).toEqual([]);
  });

  it("cron 风格 sessionKey 也不能绕过 cron_changed.finished 可信来源", async () => {
    const deviceId = "DEV-CRON-LOOKALIKE";
    await outbound.sendText({
      to: deviceId,
      text: "看起来像定时任务",
      requesterSessionKey: "agent:main:cron:patrol:run:r1",
    });
    expect(readLegacyNotifications(notificationDir, deviceId)).toEqual([]);
  });

  it("旧 cron 时间关联 tracker 不能生成收件箱条目", async () => {
    const deviceId = "DEV-TRACKER";
    sseEmitter.addConnection(deviceId, new MockRes() as never);
    noteCronActivity("job-1", "每日科技");
    await outbound.sendText({ to: deviceId, text: "时间上接近 cron 的消息" });
    expect(readLegacyNotifications(notificationDir, deviceId)).toEqual([]);
  });

  it("heartbeat 无论是否携带 runId 都不写收件箱", async () => {
    const deviceId = "DEV-HEARTBEAT";
    noteHeartbeatActivity("run-heartbeat", Date.now(), "main");
    await outbound.sendText({
      to: deviceId,
      text: "heartbeat infrastructure output",
      requesterRunId: "run-heartbeat",
    });
    await outbound.sendText({ to: deviceId, text: "metadata-free heartbeat" });
    expect(readLegacyNotifications(notificationDir, deviceId)).toEqual([]);
  });
});
