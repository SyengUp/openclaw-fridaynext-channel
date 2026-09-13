import { afterEach, describe, expect, it } from "vitest";
import {
  claimRecentHeartbeatFallback,
  noteHeartbeatActivity,
  recentHeartbeatForRun,
  resetHeartbeatNotificationTrackerForTest,
} from "./heartbeat-notification-tracker.js";

describe("heartbeat-notification-tracker", () => {
  afterEach(() => resetHeartbeatNotificationTrackerForTest());

  it("returns null before activity or without an exact run id", () => {
    expect(recentHeartbeatForRun("missing")).toBeNull();
    noteHeartbeatActivity("run-1", 1_000);
    expect(recentHeartbeatForRun(undefined, 1_500)).toBeNull();
    expect(recentHeartbeatForRun("other-run", 1_500)).toBeNull();
  });

  it("returns the exact run right after activity", () => {
    noteHeartbeatActivity("run-1", 1_000);
    expect(recentHeartbeatForRun("run-1", 1_500)).toEqual({ agentId: null });
  });

  it("keeps the run within the window and expires it after", () => {
    const WINDOW_MS = 10 * 60_000;
    noteHeartbeatActivity("run-1", 1_000);
    expect(recentHeartbeatForRun("run-1", 1_000 + 60_000)).toEqual({ agentId: null });
    expect(recentHeartbeatForRun("run-1", 1_000 + WINDOW_MS + 1)).toBeNull();
  });

  it("records and returns the origin agent id within the window", () => {
    const WINDOW_MS = 10 * 60_000;
    noteHeartbeatActivity("run-1", 1_000, "hamaestro");
    expect(recentHeartbeatForRun("run-1", 1_000 + 60_000)?.agentId).toBe("hamaestro");
    expect(recentHeartbeatForRun("run-1", 1_000 + WINDOW_MS + 1)).toBeNull();
  });

  it("normalizes a blank/absent origin agent id to null", () => {
    noteHeartbeatActivity("run-1", 1_000, "   ");
    expect(recentHeartbeatForRun("run-1", 1_500)?.agentId).toBeNull();
    noteHeartbeatActivity("run-2", 2_000);
    expect(recentHeartbeatForRun("run-2", 2_500)?.agentId).toBeNull();
  });

  it("offers one run-scoped fallback claim, then consumes it", () => {
    noteHeartbeatActivity("run-1", 1_000, "hamaestro");
    expect(claimRecentHeartbeatFallback(1_500)).toEqual({ agentId: "hamaestro" });
    expect(claimRecentHeartbeatFallback(1_600)).toBeNull();
  });

  it("expires an unclaimed fallback with the heartbeat run", () => {
    const WINDOW_MS = 10 * 60_000;
    noteHeartbeatActivity("run-1", 1_000);
    expect(claimRecentHeartbeatFallback(1_000 + WINDOW_MS + 1)).toBeNull();
  });
});
