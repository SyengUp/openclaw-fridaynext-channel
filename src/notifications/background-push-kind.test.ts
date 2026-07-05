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
});
