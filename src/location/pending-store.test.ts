import { describe, expect, it, vi } from "vitest";

describe("location pending-store", () => {
  it("keeps the live waiter reachable across plugin module reloads", async () => {
    const beforeReload = await import("./pending-store.js");
    const waiter = beforeReload.waitForLocationQueryResult({
      requestId: "location-before-reload",
      deviceId: "phone-1",
    });

    vi.resetModules();
    const afterReload = await import("./pending-store.js");

    try {
      expect(afterReload.hasPendingLocationQuery("location-before-reload")).toBe(true);
      expect(
        afterReload.resolveLocationQueryResult("location-before-reload", {
          ok: true,
          payload: { latitude: 31.2, longitude: 121.5 },
        }),
      ).toBe(true);
      await expect(waiter).resolves.toEqual({
        ok: true,
        payload: { latitude: 31.2, longitude: 121.5 },
      });
      expect(beforeReload.locationQueryBusyForDevice("phone-1")).toBe(false);
    } finally {
      beforeReload.resetLocationQueryPendingStoreForTest();
      afterReload.resetLocationQueryPendingStoreForTest();
    }
  });
});
