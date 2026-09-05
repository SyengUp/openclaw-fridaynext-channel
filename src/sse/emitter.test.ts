import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { sseEmitter } from "./emitter.js";
import { fridaySseOfflineQueue, setOfflineQueueBaseDirForTest } from "./offline-queue.js";
import { getRuntimeV3Store, setRuntimeV3RootForTest } from "../runtime-v3/runtime-store.js";

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
    vi.useRealTimers();
    sseEmitter.resetForTest();
    setRuntimeV3RootForTest(null);
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

  it("broadcastLive does not persist to the offline queue or assign ids", () => {
    const c = new MockRes();
    sseEmitter.addConnection("device-live", c as never);
    sseEmitter.setBacklogLimit(50);
    sseEmitter.broadcast({ type: "agent", data: { text: "queued" } }, "device-live", true);
    sseEmitter.broadcastLive(
      { type: "session-status", data: { sessionKey: "agent:main:s", hasActiveRun: true } },
      true,
    );

    const body = c.writes.join("");
    expect(body).toContain("event: session-status");
    expect(body).toContain("agent:main:s");
    expect(body).not.toMatch(/id: \d+\nevent: session-status/);
    expect(fridaySseOfflineQueue.readAfter("device-live", 0).map((e) => e.event)).toEqual(["agent"]);
    sseEmitter.removeConnection("device-live");
  });

  it("broadcastLiveToDevice writes only to that device and skips the backlog", () => {
    const a = new MockRes();
    const b = new MockRes();
    sseEmitter.addConnection("device-a-talk", a as never);
    sseEmitter.addConnection("device-b-talk", b as never);
    sseEmitter.broadcastLiveToDevice(
      { type: "talk", data: { type: "audio", audioBase64: "YWI=" } },
      "device-a-talk",
      true,
    );

    expect(a.writes.join("")).toContain("event: talk");
    expect(a.writes.join("")).not.toMatch(/id: \d+\nevent: talk/);
    expect(b.writes.join("")).toBe("");
    expect(fridaySseOfflineQueue.readAfter("device-a-talk", 0)).toEqual([]);
    sseEmitter.removeConnection("device-a-talk");
    sseEmitter.removeConnection("device-b-talk");
  });

  it("batches captured interleaved updates without losing source order before terminal", () => {
    setRuntimeV3RootForTest(path.join(tmp, "runtime-v3-captured"));
    const store = getRuntimeV3Store();
    const run = store.acceptCommand({
      clientRequestId: "captured-updates", deviceId: "DEVICE-CAPTURED",
      sessionKey: "agent:main:captured", agentId: "main", text: "test", attachments: [],
    }).run!;
    const captured = JSON.parse(fs.readFileSync(new URL("./fixtures/runtime-streaming-updates.json", import.meta.url), "utf8")) as Array<{
      payload: { _sourceEventType: "agent"; _sourceEventData: Record<string, unknown> };
    }>;
    const sources = captured.map(({ payload }) => ({
      type: payload._sourceEventType,
      data: { ...payload._sourceEventData, runId: run.runId, sessionKey: run.sessionKey },
    }));
    for (const source of sources) sseEmitter.broadcastToRun(run.runId, source);
    // 结束帧是顺序屏障，不必等定时器才提交最后几个字。
    sseEmitter.broadcastToRun(run.runId, {
      type: "agent", data: { runId: run.runId, seq: 9999, stream: "lifecycle", data: { phase: "end" } },
    });
    const events = store.eventsForRun(run.runId);
    expect(events.length).toBeLessThanOrEqual(3);
    expect(events.at(-1)?.eventType).toBe("run.completed");
    const replay = events.slice(0, -1).flatMap(({ payload }) =>
      Array.isArray(payload._sourceEventBatch)
        ? payload._sourceEventBatch
        : [{ type: payload._sourceEventType, data: payload._sourceEventData }],
    );
    expect(replay).toEqual(sources);
  });

  it("flushes updates on the timer and keeps concurrent runs isolated", async () => {
    vi.useFakeTimers();
    setRuntimeV3RootForTest(path.join(tmp, "runtime-v3-timer"));
    const store = getRuntimeV3Store();
    const runs = ["one", "two"].map((key) => store.acceptCommand({
      clientRequestId: `timer-${key}`, deviceId: "DEVICE-TIMER",
      sessionKey: `agent:main:${key}`, agentId: "main", text: "test", attachments: [],
    }).run!);
    const source = (runId: string, seq: number) => ({
      type: "agent" as const,
      data: { runId, seq, stream: "assistant", data: { delta: String(seq) } },
    });
    sseEmitter.broadcastToRun(runs[0].runId, source(runs[0].runId, 1));
    sseEmitter.broadcastToRun(runs[1].runId, source(runs[1].runId, 1));
    sseEmitter.broadcastToRun(runs[0].runId, source(runs[0].runId, 2));
    sseEmitter.broadcastToRun(runs[0].runId, source(runs[0].runId, 2));
    expect(store.eventsForRun(runs[0].runId)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(16);
    expect(store.eventsForRun(runs[0].runId)).toHaveLength(1);
    expect(store.eventsForRun(runs[1].runId)).toHaveLength(1);
    expect(store.eventsForRun(runs[0].runId)[0].payload._sourceEventBatch).toEqual([
      source(runs[0].runId, 1), source(runs[0].runId, 2),
    ]);
  });

  it("bounds cumulative-text batches by bytes as well as event count", () => {
    setRuntimeV3RootForTest(path.join(tmp, "runtime-v3-bytes"));
    const store = getRuntimeV3Store();
    const run = store.acceptCommand({
      clientRequestId: "batch-bytes", deviceId: "DEVICE-BYTES",
      sessionKey: "agent:main:bytes", agentId: "main", text: "test", attachments: [],
    }).run!;
    for (let seq = 1; seq <= 12; seq++) {
      sseEmitter.broadcastToRun(run.runId, {
        type: "agent", data: { runId: run.runId, seq, stream: "assistant", data: { delta: "字", text: "字".repeat(20000) } },
      });
    }
    sseEmitter.flushRuntimeV3Run(run.runId);
    const batches = store.eventsForRun(run.runId);
    expect(batches.every((event) => Buffer.byteLength(JSON.stringify(event)) < 300_000)).toBe(true);
    expect(batches.flatMap(({ payload }) => Array.isArray(payload._sourceEventBatch)
      ? payload._sourceEventBatch : [{ type: payload._sourceEventType, data: payload._sourceEventData }])).toHaveLength(12);
  });

  it("mirrors the same core source event only once", () => {
    setRuntimeV3RootForTest(path.join(tmp, "runtime-v3"));
    const store = getRuntimeV3Store();
    const run = store.acceptCommand({
      clientRequestId: "request-dedup",
      deviceId: "DEVICE-DEDUP",
      sessionKey: "agent:operator:dedup",
      agentId: "operator",
      text: "hello",
      attachments: [],
    }).run!;
    const source = {
      type: "agent" as const,
      data: {
        runId: run.runId,
        seq: 7,
        stream: "assistant",
        data: { text: "same source callback" },
      },
    };

    sseEmitter.broadcastToRun(run.runId, source);
    sseEmitter.broadcastToRun(run.runId, source);

    expect(store.eventsForRun(run.runId)).toHaveLength(1);
    expect(store.run(run.runId)?.lastRunSeq).toBe(1);
  });
});
