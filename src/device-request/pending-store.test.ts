import { afterEach, describe, expect, it } from "vitest";
import { createDeviceRequestPendingStore } from "./pending-store.js";

describe("device-request pending-store", () => {
  const store = createDeviceRequestPendingStore({
    timeoutCode: "TEST_TIMEOUT",
    timeoutMessage: "Timed out",
  });

  afterEach(() => {
    store.resetForTest();
  });

  it("resolves a waiting request", async () => {
    const waiter = store.waitForResult({ requestId: "r1", deviceId: "dev-a" });
    expect(store.busyForDevice("dev-a")).toBe(true);
    expect(store.resolveResult("r1", { ok: true, payload: { steps: 10 } })).toBe(true);
    await expect(waiter).resolves.toEqual({ ok: true, payload: { steps: 10 } });
    expect(store.busyForDevice("dev-a")).toBe(false);
  });

  it("returns false for unknown requestId", () => {
    expect(store.resolveResult("missing", { ok: true, payload: {} })).toBe(false);
  });

  it("times out with the configured code and message", async () => {
    const waiter = store.waitForResult({
      requestId: "r-timeout",
      deviceId: "dev-b",
      timeoutMs: 20,
    });
    const outcome = await waiter;
    expect(outcome).toEqual({
      ok: false,
      error: { code: "TEST_TIMEOUT", message: "Timed out" },
    });
    expect(store.busyForDevice("dev-b")).toBe(false);
  });

  it("keeps two store instances independent (health + calendar concurrent)", async () => {
    const other = createDeviceRequestPendingStore({
      timeoutCode: "OTHER_TIMEOUT",
      timeoutMessage: "Other timed out",
    });
    const healthWaiter = store.waitForResult({ requestId: "h1", deviceId: "dev-a" });
    const calendarWaiter = other.waitForResult({ requestId: "c1", deviceId: "dev-a" });
    // Per-device single-flight is per store: both in flight on the same device.
    expect(store.busyForDevice("dev-a")).toBe(true);
    expect(other.busyForDevice("dev-a")).toBe(true);
    expect(store.resolveResult("h1", { ok: true, payload: { kind: "health" } })).toBe(true);
    expect(other.resolveResult("c1", { ok: true, payload: { kind: "calendar" } })).toBe(true);
    await expect(healthWaiter).resolves.toEqual({ ok: true, payload: { kind: "health" } });
    await expect(calendarWaiter).resolves.toEqual({ ok: true, payload: { kind: "calendar" } });
    other.resetForTest();
  });
});
