import { afterEach, describe, expect, it } from "vitest";
import {
  noteHeartbeatActivity,
  recentHeartbeatAtMs,
  resetHeartbeatNotificationTrackerForTest,
} from "./heartbeat-notification-tracker.js";

describe("heartbeat-notification-tracker", () => {
  afterEach(() => resetHeartbeatNotificationTrackerForTest());

  it("returns null before any heartbeat activity", () => {
    expect(recentHeartbeatAtMs()).toBeNull();
  });

  it("returns the start timestamp right after activity", () => {
    noteHeartbeatActivity(1_000);
    expect(recentHeartbeatAtMs(1_500)).toBe(1_000);
  });

  it("keeps the timestamp within the window and expires it after", () => {
    const WINDOW_MS = 10 * 60_000;
    noteHeartbeatActivity(1_000);
    expect(recentHeartbeatAtMs(1_000 + 60_000)).toBe(1_000); // within window
    expect(recentHeartbeatAtMs(1_000 + WINDOW_MS + 1)).toBeNull(); // past window
  });
});
