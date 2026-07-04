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

  it("fallbackKind captures unclassified keys (real cron deliveries carry no :cron: key)", () => {
    // Offline device: a real cron delivery resolves to a device/history session key —
    // classification misses it, so the caller passes fallbackKind "push".
    const captured = store.append({
      deviceId: DEV, ts: 1000, sourceSessionKey: "agent:main:friday-next-AAAA-BBBB",
      text: "早上好", hasMedia: false, fallbackKind: "push",
    });
    expect(captured?.kind).toBe("push");
    expect(captured?.seq).toBe(1);

    // Online device (fallbackKind null): unclassified keys stay ignored.
    const ignored = store.append({
      deviceId: DEV, ts: 2000, sourceSessionKey: "agent:main:friday-next-AAAA-BBBB",
      text: "普通回复", hasMedia: false, fallbackKind: null,
    });
    expect(ignored).toBeNull();

    // Classified keys keep their real kind even when a fallback is provided.
    const cron = store.append({
      deviceId: DEV, ts: 3000, sourceSessionKey: "agent:main:cron:x:run:y",
      text: "定时", hasMedia: false, fallbackKind: "push",
    });
    expect(cron?.kind).toBe("cron");
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

  it("delete removes one entry by seq and is idempotent", () => {
    for (let i = 1; i <= 3; i++) {
      store.append({ deviceId: DEV, ts: i, sourceSessionKey: "agent:main:cron:a:run:" + i, text: String(i), hasMedia: false });
    }
    expect(store.delete(DEV, 2)).toBe(true);
    expect(store.readAfter(DEV, 0).map((n) => n.seq)).toEqual([1, 3]);
    // Deleting the same seq again is a no-op (already gone).
    expect(store.delete(DEV, 2)).toBe(false);
    // Seq counter stays monotonic — the next append does NOT reuse 2.
    const next = store.append({ deviceId: DEV, ts: 4, sourceSessionKey: "agent:main:cron:a:run:4", text: "4", hasMedia: false });
    expect(next?.seq).toBe(4);
  });

  it("delete returns false for an unknown device", () => {
    expect(store.delete("no-such-device", 1)).toBe(false);
  });

  // Regression: deleting entries must NOT let a later append reuse a seq — even across a
  // process restart (fresh store instance) where the in-memory counter is gone. A reused seq
  // collides with the app's tombstone for the OLD notification and gets silently eaten.
  it("never reuses a seq after deletion, even across a store reload (restart)", () => {
    for (let i = 1; i <= 3; i++) {
      store.append({ deviceId: DEV, ts: i, sourceSessionKey: "agent:main:cron:a:run:" + i, text: String(i), hasMedia: false });
    }
    store.delete(DEV, 3);
    store.delete(DEV, 2); // file max is now 1
    // Simulate a gateway restart: a fresh store reading the same dir must honor the durable counter.
    const restarted = new FridayNotificationsStore(tmpDir);
    const next = restarted.append({ deviceId: DEV, ts: 4, sourceSessionKey: "agent:main:cron:a:run:4", text: "4", hasMedia: false });
    expect(next?.seq).toBe(4); // NOT 2 (the post-deletion file max + 1)
  });

  // Robustness: the durable seq-counter file is a single point of failure. The soft-delete
  // tombstone (a content-less {seq,ts,deleted:true} line) keeps scanMaxSeq at the true high-water,
  // so seqs stay monotonic even if that counter file is corrupted or lost entirely.
  it("does not reuse a seq after deletion even if the counter file is corrupted", () => {
    for (let i = 1; i <= 3; i++) {
      store.append({ deviceId: DEV, ts: i, sourceSessionKey: "agent:main:cron:a:run:" + i, text: String(i), hasMedia: false });
    }
    store.delete(DEV, 3);
    store.delete(DEV, 2);
    fs.writeFileSync(path.join(tmpDir, "_seq-counters.json"), "{ not valid json");
    const restarted = new FridayNotificationsStore(tmpDir);
    const next = restarted.append({ deviceId: DEV, ts: 4, sourceSessionKey: "agent:main:cron:a:run:4", text: "4", hasMedia: false });
    expect(next?.seq).toBe(4);
  });

  it("does not reuse a seq after deletion even if the counter file is lost", () => {
    for (let i = 1; i <= 3; i++) {
      store.append({ deviceId: DEV, ts: i, sourceSessionKey: "agent:main:cron:a:run:" + i, text: String(i), hasMedia: false });
    }
    store.delete(DEV, 3);
    store.delete(DEV, 2);
    fs.rmSync(path.join(tmpDir, "_seq-counters.json"), { force: true });
    const restarted = new FridayNotificationsStore(tmpDir);
    const next = restarted.append({ deviceId: DEV, ts: 4, sourceSessionKey: "agent:main:cron:a:run:4", text: "4", hasMedia: false });
    expect(next?.seq).toBe(4);
  });

  it("soft-delete removes the content but keeps a tombstone (readAfter hides it)", () => {
    store.append({ deviceId: DEV, ts: 1, sourceSessionKey: "agent:main:cron:a:run:1", text: "secret content", hasMedia: false });
    store.delete(DEV, 1);
    // Content is gone from the readable log …
    expect(store.readAfter(DEV, 0)).toHaveLength(0);
    // … and the raw file no longer contains the text (permanent removal), only a tombstone.
    const raw = fs.readFileSync(path.join(tmpDir, `${DEV.toUpperCase()}.jsonl`), "utf8");
    expect(raw).not.toContain("secret content");
    expect(raw).toContain('"deleted":true');
  });
});
