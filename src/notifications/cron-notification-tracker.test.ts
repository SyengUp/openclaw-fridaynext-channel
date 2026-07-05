import { afterEach, describe, expect, it } from "vitest";
import {
  noteCronActivity,
  recentCron,
  recentCronJobName,
  recentCronAgentId,
  resetCronNotificationTrackerForTest,
} from "./cron-notification-tracker.js";

describe("cron-notification-tracker", () => {
  afterEach(() => resetCronNotificationTrackerForTest());

  it("returns null before any cron activity", () => {
    expect(recentCronJobName()).toBeNull();
  });

  it("returns the job name right after activity", () => {
    noteCronActivity("job-1", "自动化");
    expect(recentCronJobName()).toBe("自动化");
  });

  it("exposes the jobId (durable key for live name resolution)", () => {
    noteCronActivity("job-1", "自动化");
    expect(recentCron()).toEqual({ jobId: "job-1", name: "自动化" });
  });

  it("still exposes the jobId even when the job has no name", () => {
    noteCronActivity("job-1", "");
    expect(recentCron()?.jobId).toBe("job-1");
    expect(recentCronJobName()).toBeNull();
  });

  it("keeps the name within the window and expires it after", () => {
    const WINDOW_MS = 15 * 60_000;
    noteCronActivity("job-1", "自动化");
    expect(recentCronJobName(Date.now() + 60_000)).toBe("自动化"); // within window
    expect(recentCronJobName(Date.now() + WINDOW_MS + 1_000)).toBeNull(); // past window
  });

  it("ignores empty jobId", () => {
    noteCronActivity("", "自动化");
    expect(recentCronJobName()).toBeNull();
  });

  it("returns null when the job has no name (falls back downstream)", () => {
    noteCronActivity("job-1", "   ");
    expect(recentCronJobName()).toBeNull();
  });

  it("latest activity wins", () => {
    noteCronActivity("job-1", "自动化");
    noteCronActivity("job-2", "每日简报");
    expect(recentCronJobName()).toBe("每日简报");
  });

  it("records the owning agent id when the event carries it, null otherwise", () => {
    noteCronActivity("job-1", "自动化", "ops-bot");
    expect(recentCronAgentId()).toBe("ops-bot");
    noteCronActivity("job-2", "简报"); // no agent → null
    expect(recentCronAgentId()).toBeNull();
  });
});
