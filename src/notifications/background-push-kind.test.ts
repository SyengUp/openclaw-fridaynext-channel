import { afterEach, describe, expect, it } from "vitest";
import { resolveBackgroundPushKind } from "./background-push-kind.js";
import {
  noteCronActivity,
  resetCronNotificationTrackerForTest,
} from "./cron-notification-tracker.js";
import {
  noteHeartbeatActivity,
  resetHeartbeatNotificationTrackerForTest,
} from "./heartbeat-notification-tracker.js";

describe("resolveBackgroundPushKind", () => {
  afterEach(() => {
    resetCronNotificationTrackerForTest();
    resetHeartbeatNotificationTrackerForTest();
  });

  it("returns null when no background trigger fired", () => {
    expect(resolveBackgroundPushKind()).toEqual({ kind: null, cron: null, agentId: null });
  });

  it("returns cron (with identity) when a cron fired recently", () => {
    noteCronActivity("job-1", "每日趣闻汇总");
    expect(resolveBackgroundPushKind()).toEqual({
      kind: "cron",
      cron: { jobId: "job-1", name: "每日趣闻汇总" },
      agentId: null,
    });
  });

  it("returns heartbeat when only a heartbeat fired recently", () => {
    noteHeartbeatActivity();
    expect(resolveBackgroundPushKind()).toEqual({ kind: "heartbeat", cron: null, agentId: null });
  });

  it("surfaces the origin agent id of the winning trigger", () => {
    noteHeartbeatActivity(Date.now(), "hamaestro");
    const hb = resolveBackgroundPushKind();
    expect(hb.kind).toBe("heartbeat");
    expect(hb.agentId).toBe("hamaestro");

    noteCronActivity("job-1", "任务", "ops-bot"); // cron fresher → wins, carries its own agent
    const cron = resolveBackgroundPushKind();
    expect(cron.kind).toBe("cron");
    expect(cron.agentId).toBe("ops-bot");
  });

  it("cron wins over heartbeat when it fired more recently", () => {
    noteHeartbeatActivity(1_000);
    noteCronActivity("job-1", "任务"); // now() > 1_000, so cron is fresher
    expect(resolveBackgroundPushKind().kind).toBe("cron");
  });

  // Regression (2026-07-31): a job that announces elsewhere must not turn a normal reply into a
  // "cron" notification, nor lend it its name.
  it("ignores a cron that does not deliver to this channel", () => {
    noteCronActivity("tg-job", "电报播报", null, {
      action: "started",
      delivery: { deliversToFridayNext: false, to: null },
    });
    expect(resolveBackgroundPushKind()).toEqual({ kind: null, cron: null, agentId: null });
  });

  it("still reports a cron push when the window is ambiguous, just without an identity", () => {
    const delivery = { deliversToFridayNext: true as const, to: null };
    noteCronActivity("job-a", "早报", "ops-bot", { action: "started", delivery });
    noteCronActivity("job-b", "晚报", "ops-bot", { action: "started", delivery });
    expect(resolveBackgroundPushKind()).toEqual({ kind: "cron", cron: null, agentId: null });
  });

  it("narrows the cron correlation to the target device", () => {
    noteCronActivity("job-b", "别的设备", null, {
      action: "started",
      delivery: { deliversToFridayNext: true, to: "DEVICE-B" },
    });
    expect(resolveBackgroundPushKind("DEVICE-A").kind).toBeNull();
    expect(resolveBackgroundPushKind("DEVICE-B").cron?.jobId).toBe("job-b");
  });
});
