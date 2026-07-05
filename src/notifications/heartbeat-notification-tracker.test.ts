import { afterEach, describe, expect, it } from "vitest";
import {
  noteHeartbeatActivity,
  recentHeartbeatAtMs,
  recentHeartbeatAgentId,
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

  it("records and returns the origin agent id within the window", () => {
    const WINDOW_MS = 10 * 60_000;
    noteHeartbeatActivity(1_000, "hamaestro");
    expect(recentHeartbeatAgentId(1_000 + 60_000)).toBe("hamaestro");
    expect(recentHeartbeatAgentId(1_000 + WINDOW_MS + 1)).toBeNull(); // expires with the window
  });

  it("normalizes a blank/absent origin agent id to null", () => {
    noteHeartbeatActivity(1_000, "   ");
    expect(recentHeartbeatAgentId(1_500)).toBeNull();
    noteHeartbeatActivity(2_000);
    expect(recentHeartbeatAgentId(2_500)).toBeNull();
  });
});
