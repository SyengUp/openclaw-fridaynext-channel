import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { sseEmitter } from "./emitter.js";
import { setOfflineQueueBaseDirForTest } from "./offline-queue.js";

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
});
