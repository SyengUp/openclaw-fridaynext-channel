import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FridayNotificationsStore,
  classifyNotificationKind,
} from "./notifications-store.js";

let tmpDir = "";
let store: FridayNotificationsStore;
const DEV = "AAAA-BBBB";

describe("FridayNotificationsStore", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-notif-"));
    store = new FridayNotificationsStore(tmpDir);
  });
  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("classifies cron / heartbeat keys, ignores normal replies", () => {
    expect(classifyNotificationKind("agent:main:cron:abc:run:def")).toBe("cron");
    expect(classifyNotificationKind("agent:ha-maestro:main:heartbeat")).toBe("heartbeat");
    expect(classifyNotificationKind("agent:main:fridaynext:mr0nwrtf")).toBeNull();
    expect(classifyNotificationKind("agent:main:main")).toBeNull();
    expect(classifyNotificationKind(undefined)).toBeNull();
  });

  it("appends only background pushes, with monotonic seq + derived agent/kind", () => {
    const a = store.append({
      deviceId: DEV, ts: 1000, sourceSessionKey: "agent:main:cron:x:run:y",
      text: "家庭巡检报告", hasMedia: false,
    });
    const b = store.append({
      deviceId: DEV, ts: 2000, sourceSessionKey: "agent:ha-maestro:main:heartbeat",
      text: "心跳巡检", hasMedia: false,
    });
    const skipped = store.append({
      deviceId: DEV, ts: 3000, sourceSessionKey: "agent:main:fridaynext:abc",
      text: "普通回复", hasMedia: false,
    });
    expect(a?.seq).toBe(1);
    expect(a?.agentId).toBe("main");
    expect(a?.kind).toBe("cron");
    expect(b?.seq).toBe(2);
    expect(b?.agentId).toBe("ha-maestro");
    expect(b?.kind).toBe("heartbeat");
    expect(skipped).toBeNull();
  });

  it("readAfter returns only newer entries, oldest-first", () => {
    store.append({ deviceId: DEV, ts: 1, sourceSessionKey: "agent:main:cron:a:run:1", text: "1", hasMedia: false });
    store.append({ deviceId: DEV, ts: 2, sourceSessionKey: "agent:main:cron:a:run:2", text: "2", hasMedia: false });
    store.append({ deviceId: DEV, ts: 3, sourceSessionKey: "agent:main:cron:a:run:3", text: "3", hasMedia: false });
    const after1 = store.readAfter(DEV, 1);
    expect(after1.map((n) => n.text)).toEqual(["2", "3"]);
    expect(store.readAfter(DEV, 0)).toHaveLength(3);
    expect(store.readAfter(DEV, 3)).toHaveLength(0);
  });

  it("seq survives a fresh store instance (resumes from file)", () => {
    store.append({ deviceId: DEV, ts: 1, sourceSessionKey: "agent:main:cron:a:run:1", text: "1", hasMedia: false });
    const store2 = new FridayNotificationsStore(tmpDir);
    const n = store2.append({ deviceId: DEV, ts: 2, sourceSessionKey: "agent:main:cron:a:run:2", text: "2", hasMedia: false });
    expect(n?.seq).toBe(2); // continued, not reset to 1
  });

  it("is keyed per device (case-insensitive)", () => {
    store.append({ deviceId: "dev-one", ts: 1, sourceSessionKey: "agent:main:cron:a:run:1", text: "one", hasMedia: false });
    store.append({ deviceId: "DEV-TWO", ts: 1, sourceSessionKey: "agent:main:cron:b:run:1", text: "two", hasMedia: false });
    expect(store.readAfter("DEV-ONE", 0).map((n) => n.text)).toEqual(["one"]);
    expect(store.readAfter("dev-two", 0).map((n) => n.text)).toEqual(["two"]);
  });

  it("caps the log to keep last N", () => {
    for (let i = 0; i < 10; i++) {
      store.append({ deviceId: DEV, ts: i, sourceSessionKey: "agent:main:cron:a:run:" + i, text: String(i), hasMedia: false, keep: 5 });
    }
    const all = store.readAfter(DEV, 0);
    expect(all).toHaveLength(5);
    expect(all.map((n) => n.text)).toEqual(["5", "6", "7", "8", "9"]);
  });
});
