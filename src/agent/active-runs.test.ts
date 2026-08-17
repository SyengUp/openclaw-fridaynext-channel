import { afterEach, describe, expect, it } from "vitest";
import {
  getActiveRunIds,
  getActiveSessionKeys,
  hasActiveSession,
  observeAgentEventForActiveRuns,
  resetActiveRunsForTest,
} from "./active-runs.js";

describe("observeAgentEventForActiveRuns", () => {
  afterEach(() => {
    resetActiveRunsForTest();
  });

  function lifecycle(
    phase: string,
    runId: string,
    sessionKey?: string,
  ): Parameters<typeof observeAgentEventForActiveRuns>[0] {
    return {
      stream: "lifecycle",
      runId,
      data: { phase },
      ...(sessionKey ? { sessionKey } : {}),
    };
  }

  it("ignores non-lifecycle streams", () => {
    expect(
      observeAgentEventForActiveRuns({
        stream: "assistant",
        runId: "r1",
        data: { phase: "start" },
        sessionKey: "agent:main:chat",
      }),
    ).toBeUndefined();
    expect(getActiveRunIds()).toEqual([]);
  });

  it("records start/end by canonical session key", () => {
    expect(observeAgentEventForActiveRuns(lifecycle("start", "r1", "agent:main:chat"))).toEqual({
      sessionKey: "agent:main:chat",
      hasActiveRun: true,
    });
    expect(getActiveRunIds()).toEqual(["r1"]);
    expect(getActiveSessionKeys()).toEqual(["agent:main:chat"]);
    expect(hasActiveSession("agent:main:chat")).toBe(true);
    expect(hasActiveSession("chat")).toBe(true);

    expect(observeAgentEventForActiveRuns(lifecycle("end", "r1", "agent:main:chat"))).toEqual({
      sessionKey: "agent:main:chat",
      hasActiveRun: false,
    });
    expect(getActiveRunIds()).toEqual([]);
    expect(getActiveSessionKeys()).toEqual([]);
    expect(hasActiveSession("agent:main:chat")).toBe(false);
  });

  it("tracks a start with no Friday device mapping (cross-channel)", () => {
    const change = observeAgentEventForActiveRuns(
      lifecycle("start", "webchat-run", "agent:main:webchat:abc"),
    );
    expect(change).toEqual({
      sessionKey: "agent:main:webchat:abc",
      hasActiveRun: true,
    });
    expect(hasActiveSession("agent:main:webchat:abc")).toBe(true);
  });

  it("does not flip hasActiveRun while another run on the same session is live", () => {
    observeAgentEventForActiveRuns(lifecycle("start", "r1", "agent:main:s"));
    expect(observeAgentEventForActiveRuns(lifecycle("start", "r2", "agent:main:s"))).toBeUndefined();
    expect(observeAgentEventForActiveRuns(lifecycle("end", "r1"))).toBeUndefined();
    expect(hasActiveSession("agent:main:s")).toBe(true);
    expect(observeAgentEventForActiveRuns(lifecycle("error", "r2"))).toEqual({
      sessionKey: "agent:main:s",
      hasActiveRun: false,
    });
  });

  it("end without a remembered sessionKey still clears when the event carries one", () => {
    observeAgentEventForActiveRuns(lifecycle("start", "r1", "agent:main:s"));
    expect(observeAgentEventForActiveRuns(lifecycle("end", "r1"))).toEqual({
      sessionKey: "agent:main:s",
      hasActiveRun: false,
    });
  });

  it("start without any sessionKey still counts the run id", () => {
    expect(observeAgentEventForActiveRuns(lifecycle("start", "orphan"))).toBeUndefined();
    expect(getActiveRunIds()).toEqual(["orphan"]);
    expect(getActiveSessionKeys()).toEqual([]);
  });
});
