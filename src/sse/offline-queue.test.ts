import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FridaySseOfflineQueue, setOfflineQueueBaseDirForTest } from "./offline-queue.js";

describe("FridaySseOfflineQueue", () => {
  let tmp = "";

  afterEach(() => {
    setOfflineQueueBaseDirForTest(null);
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
      tmp = "";
    }
  });

  it("append / readAfter / latestId", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-q-"));
    setOfflineQueueBaseDirForTest(tmp);
    const q = new FridaySseOfflineQueue(tmp);
    expect(q.latestId("dev-a")).toBe(0);
    q.append("dev-a", 1, "agent", { x: 1 }, 100);
    q.append("dev-a", 2, "deliver", { y: 2 }, 100);
    expect(q.latestId("dev-a")).toBe(2);
    expect(q.readAfter("dev-a", 0).map((e) => e.id)).toEqual([1, 2]);
    expect(q.readAfter("dev-a", 1).map((e) => e.id)).toEqual([2]);
  });

  it("does not persist connected", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-q-"));
    setOfflineQueueBaseDirForTest(tmp);
    const q = new FridaySseOfflineQueue(tmp);
    q.append("dev-b", 1, "connected", { ok: true }, 100);
    expect(q.readAfter("dev-b", 0)).toEqual([]);
    expect(q.latestId("dev-b")).toBe(0);
  });

  it("truncateKeepLastN drops oldest", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-q-"));
    setOfflineQueueBaseDirForTest(tmp);
    const q = new FridaySseOfflineQueue(tmp);
    for (let i = 1; i <= 5; i++) {
      q.append("dev-c", i, "agent", { i }, 0);
    }
    q.truncateKeepLastN("dev-c", 2);
    const rest = q.readAfter("dev-c", 0);
    expect(rest.map((e) => e.id)).toEqual([4, 5]);
  });

  it("append with backlogLimit truncates", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-q-"));
    setOfflineQueueBaseDirForTest(tmp);
    const q = new FridaySseOfflineQueue(tmp);
    for (let i = 1; i <= 4; i++) {
      q.append("dev-d", i, "agent", { i }, 2);
    }
    const rest = q.readAfter("dev-d", 0);
    expect(rest.map((e) => e.id)).toEqual([3, 4]);
  });

  // 整文件重写是摊销的：只有涨出半个上限的余量才重写一次，而不是每 append 一条重写一次。
  // 文件因此在 [keep, keep + keep/2] 之间浮动，但绝不无界增长。
  it("keeps the backlog bounded without rewriting on every append", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-q-"));
    setOfflineQueueBaseDirForTest(tmp);
    const q = new FridaySseOfflineQueue(tmp);
    const keep = 20;
    const truncateSpy = vi.spyOn(q, "truncateKeepLastN");

    for (let i = 1; i <= 200; i++) {
      q.append("dev-e", i, "agent", { i }, keep);
    }

    const all = q.readAfter("dev-e", 0);
    expect(all.length).toBeLessThanOrEqual(keep + Math.floor(keep / 2));
    expect(all.length).toBeGreaterThanOrEqual(keep);
    expect(all[all.length - 1]?.id).toBe(200);   // 最新的一定还在
    // 每 keep/2 条才整文件重写一次：200 条约 18 次，而不是「每条一次」的 200 次。
    expect(truncateSpy.mock.calls.length).toBeLessThanOrEqual(20);
    truncateSpy.mockRestore();
  });

  // 进程内首次 append 会与磁盘对齐一次；之后靠内存计数，不再全文件扫描。
  it("recovers the line count from disk when a fresh instance takes over the file", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-q-"));
    setOfflineQueueBaseDirForTest(tmp);
    const first = new FridaySseOfflineQueue(tmp);
    for (let i = 1; i <= 30; i++) {
      first.append("dev-f", i, "agent", { i }, 10);
    }
    // 模拟网关重启：新实例接手同一个文件
    const second = new FridaySseOfflineQueue(tmp);
    expect(second.latestId("dev-f")).toBe(30);
    for (let i = 31; i <= 60; i++) {
      second.append("dev-f", i, "agent", { i }, 10);
    }
    const all = second.readAfter("dev-f", 0);
    expect(all.length).toBeLessThanOrEqual(15);
    expect(all[all.length - 1]?.id).toBe(60);
  });
});
