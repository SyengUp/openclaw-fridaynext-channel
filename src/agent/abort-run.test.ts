import { describe, expect, it, vi } from "vitest";
import { abortRunForSessionKey } from "./abort-run.js";

describe("abortRunForSessionKey", () => {
  it("resolves sessionKey → sessionId then fires a PLAIN abort (canonical clean stop)", async () => {
    const abortAgentHarnessRun = vi.fn().mockReturnValue(true);
    const resolveActiveEmbeddedRunSessionId = vi.fn().mockReturnValue("sid-9");

    const result = await abortRunForSessionKey("sk-9", {
      resolveActiveEmbeddedRunSessionId,
      abortAgentHarnessRun,
    });

    expect(resolveActiveEmbeddedRunSessionId).toHaveBeenCalledWith("sk-9");
    // Plain abort by internal sessionId — fires handle.abort(), no drain/forceClear.
    expect(abortAgentHarnessRun).toHaveBeenCalledWith("sid-9");
    expect(result).toEqual({ aborted: true });
  });

  it("falls back to the agent-qualified store key when the raw key misses (core ≥2026.7.1)", async () => {
    const abortAgentHarnessRun = vi.fn().mockReturnValue(true);
    const resolveActiveEmbeddedRunSessionId = vi.fn((key: string) =>
      key === "agent:main:friday:direct:dev:1" ? "sid-agent-scoped" : undefined,
    );

    const result = await abortRunForSessionKey("friday:direct:dev:1", {
      resolveActiveEmbeddedRunSessionId,
      abortAgentHarnessRun,
    });

    expect(resolveActiveEmbeddedRunSessionId).toHaveBeenNthCalledWith(1, "friday:direct:dev:1");
    expect(resolveActiveEmbeddedRunSessionId).toHaveBeenNthCalledWith(
      2,
      "agent:main:friday:direct:dev:1",
    );
    expect(abortAgentHarnessRun).toHaveBeenCalledWith("sid-agent-scoped");
    expect(result).toEqual({ aborted: true });
  });

  it("returns a no-op without aborting when there is no active run for the sessionKey", async () => {
    const abortAgentHarnessRun = vi.fn();
    const result = await abortRunForSessionKey("sk-x", {
      resolveActiveEmbeddedRunSessionId: () => undefined,
      abortAgentHarnessRun,
    });
    expect(abortAgentHarnessRun).not.toHaveBeenCalled();
    expect(result).toEqual({ aborted: false });
  });

  it("prefers the canonical session stop (reply operation marked aborted_by_user first)", async () => {
    const abortAgentHarnessRun = vi.fn();
    const resolveActiveEmbeddedRunSessionId = vi.fn().mockReturnValue("sid-9");
    const abortSessionRunTarget = vi.fn().mockResolvedValue({ active: true, aborted: true });

    const result = await abortRunForSessionKey("friday:direct:dev:1", {
      resolveActiveEmbeddedRunSessionId,
      abortAgentHarnessRun,
      abortSessionRunTarget,
    });

    // Canonical path aborts the embedded run itself; the plain fallback must not fire again.
    expect(abortSessionRunTarget).toHaveBeenCalledWith({
      sessionKey: "agent:main:friday:direct:dev:1",
      agentId: "main",
    });
    expect(abortAgentHarnessRun).not.toHaveBeenCalled();
    expect(result).toEqual({ aborted: true });
  });

  it("parses the agent id from an agent-qualified session key for the canonical stop", async () => {
    const abortSessionRunTarget = vi.fn().mockResolvedValue({ active: true, aborted: true });
    await abortRunForSessionKey("agent:writer:daily", {
      resolveActiveEmbeddedRunSessionId: () => undefined,
      abortAgentHarnessRun: () => false,
      abortSessionRunTarget,
    });
    expect(abortSessionRunTarget).toHaveBeenCalledWith({
      sessionKey: "agent:writer:daily",
      agentId: "writer",
    });
  });

  it("falls back to the plain abort when the canonical bridge is unavailable", async () => {
    const abortAgentHarnessRun = vi.fn().mockReturnValue(true);
    const result = await abortRunForSessionKey("sk-9", {
      resolveActiveEmbeddedRunSessionId: () => "sid-9",
      abortAgentHarnessRun,
      abortSessionRunTarget: async () => null,
    });
    expect(abortAgentHarnessRun).toHaveBeenCalledWith("sid-9");
    expect(result).toEqual({ aborted: true });
  });

  it("falls back to the plain abort when the canonical stop reports nothing aborted", async () => {
    const abortAgentHarnessRun = vi.fn().mockReturnValue(true);
    const result = await abortRunForSessionKey("sk-9", {
      resolveActiveEmbeddedRunSessionId: () => "sid-9",
      abortAgentHarnessRun,
      abortSessionRunTarget: async () => ({ active: true, aborted: false }),
    });
    expect(abortAgentHarnessRun).toHaveBeenCalledWith("sid-9");
    expect(result).toEqual({ aborted: true });
  });

  it("returns a no-op for an empty sessionKey", async () => {
    const abortAgentHarnessRun = vi.fn();
    const result = await abortRunForSessionKey("   ", {
      resolveActiveEmbeddedRunSessionId: () => "sid",
      abortAgentHarnessRun,
    });
    expect(abortAgentHarnessRun).not.toHaveBeenCalled();
    expect(result).toEqual({ aborted: false });
  });
});
