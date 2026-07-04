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
    expect(resolveBackgroundPushKind()).toEqual({ kind: null, cron: null });
  });

  it("returns cron (with identity) when a cron fired recently", () => {
    noteCronActivity("job-1", "每日趣闻汇总");
    expect(resolveBackgroundPushKind()).toEqual({
      kind: "cron",
      cron: { jobId: "job-1", name: "每日趣闻汇总" },
    });
  });

  it("returns heartbeat when only a heartbeat fired recently", () => {
    noteHeartbeatActivity();
    expect(resolveBackgroundPushKind()).toEqual({ kind: "heartbeat", cron: null });
  });

  it("cron wins over heartbeat when it fired more recently", () => {
    noteHeartbeatActivity(1_000);
    noteCronActivity("job-1", "任务"); // now() > 1_000, so cron is fresher
    expect(resolveBackgroundPushKind().kind).toBe("cron");
  });
});
