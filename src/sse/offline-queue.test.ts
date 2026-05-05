import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
});
