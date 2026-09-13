import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CronResultStore } from "./cron-result-store.js";

const roots: string[] = [];

function makeStore(): CronResultStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-inbox-v2-"));
  roots.push(root);
  return new CronResultStore(root);
}

function input(sourceIdentity: string, deviceId = "phone-a") {
  return {
    sourceIdentity,
    category: "cronResults" as const,
    kind: "cronResult" as const,
    lifecycle: "event" as const,
    occurredAtMs: 1_000,
    deviceId,
    jobId: "job-1",
    jobName: "晨报",
    agentId: "main",
    runId: sourceIdentity,
    status: "ok",
    summary: "完成",
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("CronResultStore", () => {
  it("以结构化运行身份去重并按设备隔离", () => {
    const store = makeStore();
    const first = store.append(input("run-a"));
    expect(first?.cursor).toBe(1);
    expect(store.append(input("run-a"))).toBeNull();
    expect(store.append(input("run-a", "phone-b"))?.cursor).toBe(1);
    expect(store.readAfter("PHONE-A", 0)).toHaveLength(1);
  });

  it("删除后保留 tombstone，重放不会复活", () => {
    const store = makeStore();
    const first = store.append(input("run-a"));
    expect(store.delete("phone-a", first!.cursor)).toBe(true);
    expect(store.readAfter("phone-a", 0)).toEqual([]);
    expect(store.append(input("run-a"))).toBeNull();
  });

  it("截断和进程重启后游标仍单调递增", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-inbox-v2-"));
    roots.push(root);
    const firstProcess = new CronResultStore(root);
    firstProcess.append(input("run-a"), 1);
    firstProcess.append(input("run-b"), 1);
    const secondProcess = new CronResultStore(root);
    expect(secondProcess.append(input("run-c"), 1)?.cursor).toBe(3);
    expect(secondProcess.append(input("run-a"), 1)).toBeNull();
  });
});
