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

  it("returns a no-op without aborting when there is no active run for the sessionKey", async () => {
    const abortAgentHarnessRun = vi.fn();
    const result = await abortRunForSessionKey("sk-x", {
      resolveActiveEmbeddedRunSessionId: () => undefined,
      abortAgentHarnessRun,
    });
    expect(abortAgentHarnessRun).not.toHaveBeenCalled();
    expect(result).toEqual({ aborted: false });
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
