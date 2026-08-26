import { afterEach, describe, expect, it } from "vitest";
import {
  healthQueryBusyForDevice,
  resetHealthQueryPendingStoreForTest,
  resolveHealthQueryResult,
  waitForHealthQueryResult,
} from "./pending-store.js";

describe("health-query pending-store", () => {
  afterEach(() => {
    resetHealthQueryPendingStoreForTest();
  });

  it("resolves a waiting request", async () => {
    const waiter = waitForHealthQueryResult({ requestId: "r1", deviceId: "dev-a" });
    expect(healthQueryBusyForDevice("dev-a")).toBe(true);
    expect(resolveHealthQueryResult("r1", { ok: true, payload: { steps: 10 } })).toBe(true);
    await expect(waiter).resolves.toEqual({ ok: true, payload: { steps: 10 } });
    expect(healthQueryBusyForDevice("dev-a")).toBe(false);
  });

  it("returns false for unknown requestId", () => {
    expect(resolveHealthQueryResult("missing", { ok: true, payload: {} })).toBe(false);
  });

  it("times out", async () => {
    const waiter = waitForHealthQueryResult({
      requestId: "r-timeout",
      deviceId: "dev-b",
      timeoutMs: 20,
    });
    const outcome = await waiter;
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: "HEALTH_TIMEOUT",
        message: "Timed out waiting for the iPhone to return HealthKit data",
      },
    });
    expect(healthQueryBusyForDevice("dev-b")).toBe(false);
  });
});
