import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sseEmitter } from "../sse/emitter.js";
import { captureCronChanged, resetCronResultCaptureForTest } from "./cron-result-capture.js";
import { cronResultStore, setInboxV2RootForTest } from "./cron-result-store.js";

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-cron-capture-"));
  setInboxV2RootForTest(root);
  cronResultStore.resetForTest();
  resetCronResultCaptureForTest();
  sseEmitter.resetForTest();
});

afterEach(() => {
  setInboxV2RootForTest(null);
  cronResultStore.resetForTest();
  resetCronResultCaptureForTest();
  sseEmitter.resetForTest();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("captureCronChanged", () => {
  it("只从 finished + 明确 Friday 设备投递生成 cron 结果", async () => {
    const record = await captureCronChanged({
      action: "finished",
      jobId: "job-1",
      runId: "run-1",
      runAtMs: 1_000,
      durationMs: 500,
      status: "ok",
      summary: "晨报完成",
      delivered: true,
      deliveryStatus: "delivered",
      job: {
        name: "晨报",
        agentId: "writer",
        delivery: { mode: "announce", channel: "friday-next", to: "phone-a" },
      },
    });

    expect(record).toMatchObject({
      cursor: 1,
      deviceId: "PHONE-A",
      jobId: "job-1",
      jobName: "晨报",
      agentId: "writer",
      runId: "run-1",
      occurredAtMs: 1_500,
      delivered: true,
    });
    expect(cronResultStore.readAfter("phone-a", 0)).toHaveLength(1);
  });

  it("started 可向同一稳定运行身份传递一次性任务投递事实", async () => {
    await captureCronChanged({
      action: "started",
      jobId: "once",
      sessionId: "session-once",
      job: {
        name: "一次性任务",
        delivery: { mode: "announce", channel: "friday-next", to: "phone-a" },
      },
    });
    const record = await captureCronChanged({
      action: "finished",
      jobId: "once",
      sessionId: "session-once",
      status: "error",
      error: "失败",
    });
    expect(record).toMatchObject({ deviceId: "PHONE-A", jobName: "一次性任务", status: "error" });
  });

  it("不会把同一 job 的 started 事实借给另一个 run", async () => {
    await captureCronChanged({
      action: "started",
      jobId: "job-1",
      runId: "run-a",
      job: {
        name: "晨报",
        delivery: { mode: "announce", channel: "friday-next", to: "phone-a" },
      },
    });
    expect(
      await captureCronChanged({
        action: "finished",
        jobId: "job-1",
        runId: "run-b",
        status: "ok",
      }),
    ).toBeNull();
    expect(cronResultStore.readAfter("phone-a", 0)).toEqual([]);
  });

  it("拒绝未知投递、其他通道与缺少稳定运行身份", async () => {
    expect(
      await captureCronChanged({ action: "finished", jobId: "unknown", runId: "r1" }),
    ).toBeNull();
    expect(
      await captureCronChanged({
        action: "finished",
        jobId: "telegram",
        runId: "r2",
        job: { name: "外部", delivery: { mode: "announce", channel: "telegram", to: "chat" } },
      }),
    ).toBeNull();
    expect(
      await captureCronChanged({
        action: "finished",
        jobId: "missing-run",
        job: {
          name: "无身份",
          delivery: { mode: "announce", channel: "friday-next", to: "phone-a" },
        },
      }),
    ).toBeNull();
    expect(cronResultStore.readAfter("phone-a", 0)).toEqual([]);
  });
});
