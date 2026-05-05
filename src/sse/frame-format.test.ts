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

describe("sse frame format", () => {
  let tmp = "";

  beforeEach(() => {
    sseEmitter.resetForTest();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-frame-"));
    setOfflineQueueBaseDirForTest(tmp);
  });

  afterEach(() => {
    setOfflineQueueBaseDirForTest(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("emits id/event/data with raw JSON payload", () => {
    const res = new MockRes();
    sseEmitter.addConnection("frame-device", res as never);

    sseEmitter.broadcast(
      {
        type: "agent",
        data: { runId: "r1", stream: "assistant", text: "hello" },
      },
      "frame-device",
      true,
    );

    const frame = res.writes.join("");
    expect(frame).toContain("id: 1\n");
    expect(frame).toContain("event: agent\n");
    expect(frame).toContain('"runId":"r1"');
    expect(frame).toContain('"stream":"assistant"');
    expect(frame).toContain('"text":"hello"');

    sseEmitter.removeConnection("frame-device");
  });
});
