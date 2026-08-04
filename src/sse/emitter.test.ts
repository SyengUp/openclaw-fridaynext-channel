import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { sseEmitter } from "./emitter.js";
import { fridaySseOfflineQueue, setOfflineQueueBaseDirForTest } from "./offline-queue.js";

class MockRes extends EventEmitter {
  writes: string[] = [];
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
  end(): void {
    // no-op
  }
}

describe("sseEmitter", () => {
  let tmp = "";

  beforeEach(() => {
    sseEmitter.resetForTest();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-sse-emit-"));
    setOfflineQueueBaseDirForTest(tmp);
  });

  afterEach(() => {
    setOfflineQueueBaseDirForTest(null);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("tracks run-to-device mapping", () => {
    sseEmitter.trackDeviceForRun("device-a", "run-a");
    expect(sseEmitter.getDeviceIdByRunId("run-a")).toBe("DEVICE-A");
    expect(sseEmitter.getLastRunIdForDevice("device-a")).toBe("run-a");
    expect(sseEmitter.hasTrackedDevices("run-a")).toBe(true);
    sseEmitter.untrackRun("run-a");
    expect(sseEmitter.hasTrackedDevices("run-a")).toBe(false);
  });

  it("uses per-device event id sequence", () => {
    const a = new MockRes();
    const b = new MockRes();
    sseEmitter.addConnection("device-a-seq", a as never);
    sseEmitter.addConnection("device-b-seq", b as never);

    sseEmitter.broadcast({ type: "agent", data: { text: "1" } }, "device-a-seq", true);
    sseEmitter.broadcast({ type: "agent", data: { text: "2" } }, "device-a-seq", true);
    sseEmitter.broadcast({ type: "agent", data: { text: "x" } }, "device-b-seq", true);

    const aw = a.writes.join("");
    const bw = b.writes.join("");
    expect(aw).toContain("id: 1");
    expect(aw).toContain("id: 2");
    expect(bw).toContain("id: 1");

    sseEmitter.removeConnection("device-a-seq");
    sseEmitter.removeConnection("device-b-seq");
  });

  it("replays only entries after last event id from disk", () => {
    const c = new MockRes();
    sseEmitter.addConnection("device-replay", c as never);
    sseEmitter.setBacklogLimit(50);
    sseEmitter.broadcast({ type: "agent", data: { text: "a" } }, "device-replay", true);
    sseEmitter.broadcast({ type: "agent", data: { text: "b" } }, "device-replay", true);
    sseEmitter.broadcast({ type: "agent", data: { text: "c" } }, "device-replay", true);

    c.writes = [];
    const replayed = sseEmitter.replayBacklog("device-replay", 1);
    expect(replayed).toBe(2);
    const body = c.writes.join("");
    expect(body).toContain("id: 2");
    expect(body).toContain("id: 3");
    expect(body).not.toContain('text":"a"');

    sseEmitter.removeConnection("device-replay");
  });

  // 序号来源：进程内首次见到该设备时与磁盘对齐一次，之后靠内存计数。
  // 此前每个事件都要 latestId() 全文件读+逐行 JSON.parse——长回答的每个 delta 都付一次，
  // 且是同步 I/O 跑在网关主事件循环上。
  it("scans the queue file at most once per device instead of on every event", () => {
    const c = new MockRes();
    sseEmitter.addConnection("device-seq-scan", c as never);
    sseEmitter.setBacklogLimit(50);
    const latestIdSpy = vi.spyOn(fridaySseOfflineQueue, "latestId");

    for (let i = 0; i < 50; i++) {
      sseEmitter.broadcast({ type: "agent", data: { text: `d${i}` } }, "device-seq-scan", true);
    }

    expect(latestIdSpy.mock.calls.length).toBeLessThanOrEqual(1);
    // 序号仍严格递增、无重号
    expect(fridaySseOfflineQueue.readAfter("device-seq-scan", 0).map((e) => e.id)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    latestIdSpy.mockRestore();
    sseEmitter.removeConnection("device-seq-scan");
  });

  // 网关重启后内存计数为空 → 首个事件必须与磁盘对齐，Last-Event-ID 续传才不会重号。
  it("realigns the sequence with disk after a restart", () => {
    const c = new MockRes();
    sseEmitter.addConnection("device-restart", c as never);
    sseEmitter.setBacklogLimit(50);
    sseEmitter.broadcast({ type: "agent", data: { text: "a" } }, "device-restart", true);
    sseEmitter.broadcast({ type: "agent", data: { text: "b" } }, "device-restart", true);

    sseEmitter.resetForTest();          // 模拟进程重启：内存序号丢失，磁盘文件还在
    const c2 = new MockRes();
    sseEmitter.addConnection("device-restart", c2 as never);
    sseEmitter.setBacklogLimit(50);
    sseEmitter.broadcast({ type: "agent", data: { text: "c" } }, "device-restart", true);

    expect(fridaySseOfflineQueue.readAfter("device-restart", 0).map((e) => e.id)).toEqual([1, 2, 3]);
    sseEmitter.removeConnection("device-restart");
  });
});
