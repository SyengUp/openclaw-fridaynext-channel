import { afterEach, describe, expect, it } from "vitest";
import {
  noteCronActivity,
  recentCron,
  recentCronAtMs,
  recentCronJobName,
  recentCronAgentId,
  resetCronNotificationTrackerForTest,
  updateCronDeliveryTarget,
} from "./cron-notification-tracker.js";

const TO_FRIDAY = { deliversToFridayNext: true as const, to: null };
const ELSEWHERE = { deliversToFridayNext: false as const, to: null };

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

  it("records the owning agent id when the event carries it, null otherwise", () => {
    noteCronActivity("job-1", "自动化", "ops-bot");
    expect(recentCronAgentId()).toBe("ops-bot");
    resetCronNotificationTrackerForTest();
    noteCronActivity("job-2", "简报"); // no agent → null
    expect(recentCronAgentId()).toBeNull();
  });

  it("repeated activity for the SAME job keeps one record", () => {
    noteCronActivity("job-1", "自动化", null, { action: "started" });
    noteCronActivity("job-1", "自动化", null, { action: "finished" });
    expect(recentCron()).toEqual({ jobId: "job-1", name: "自动化" });
  });

  // ── Regression: 2026-07-31 「每日科技」的推送被标成「miloco-home-patrol」 ──────────────
  // Two jobs start in the same millisecond window; only one of them announces to friday-next.
  it("credits the friday-next job when an unrelated job runs at the same moment", () => {
    noteCronActivity("aca31947", "每日科技", null, { action: "started", delivery: TO_FRIDAY });
    noteCronActivity("6cc44ff1", "miloco-home-patrol", null, { action: "started" }); // unknown target
    expect(recentCronJobName()).toBe("每日科技");
  });

  it("ignores a job that announces to another channel entirely", () => {
    noteCronActivity("tg-job", "电报播报", null, { action: "started", delivery: ELSEWHERE });
    expect(recentCronAtMs()).toBeNull(); // not even a cron push as far as this device is concerned
    expect(recentCron()).toBeNull();
  });

  it("refuses to guess when two friday-next jobs are equally plausible", () => {
    noteCronActivity("job-a", "早报", null, { action: "started", delivery: TO_FRIDAY });
    noteCronActivity("job-b", "晚报", null, { action: "started", delivery: TO_FRIDAY });
    expect(recentCron()).toBeNull(); // no identity …
    expect(recentCronAtMs()).not.toBeNull(); // … but it IS still a cron push
  });

  it("prefers a still-running job over one that already finished", () => {
    noteCronActivity("job-done", "已完成", null, { action: "finished" });
    noteCronActivity("job-live", "运行中", null, { action: "started" });
    expect(recentCronJobName()).toBe("运行中");
  });

  it("excludes a job pinned to a different device", () => {
    noteCronActivity("job-other", "别的设备", null, {
      action: "started",
      delivery: { deliversToFridayNext: true, to: "DEVICE-B" },
    });
    expect(recentCronJobName(Date.now(), "DEVICE-A")).toBeNull();
    expect(recentCronJobName(Date.now(), "DEVICE-B")).toBe("别的设备");
  });

  it("adopts an asynchronously resolved delivery target", () => {
    noteCronActivity("job-1", "每日科技", null, { action: "started" });
    noteCronActivity("job-2", "巡检", null, { action: "started" });
    expect(recentCron()).toBeNull(); // ambiguous while both are unknown
    updateCronDeliveryTarget("job-1", TO_FRIDAY);
    expect(recentCronJobName()).toBe("每日科技");
  });

  it("keeps a resolved delivery target across the job's finished event", () => {
    noteCronActivity("job-1", "每日科技", null, { action: "started", delivery: TO_FRIDAY });
    noteCronActivity("job-1", "每日科技", null, { action: "finished" }); // no delivery passed
    noteCronActivity("job-2", "巡检", null, { action: "started" });
    expect(recentCronJobName()).toBe("每日科技");
  });
});
