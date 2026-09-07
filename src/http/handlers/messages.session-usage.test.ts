import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetFridayAgentForwardRuntimeForTest,
  setFridayAgentForwardRuntime,
} from "../../agent-forward-runtime.js";
import {
  markRunFinalDelivered,
  registerRunRoute,
  resetRunMetadataForTest,
  setRunMetadata,
} from "../../run-metadata.js";
import { sseEmitter } from "../../sse/emitter.js";
import { scheduleLateFinalMetaPatch } from "./messages.js";

describe("final_meta session context usage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRunMetadataForTest();
    resetFridayAgentForwardRuntimeForTest();
    sseEmitter.resetForTest();
    vi.spyOn(sseEmitter, "broadcastToRun").mockImplementation(() => {});
  });

  afterEach(() => {
    resetFridayAgentForwardRuntimeForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("takes context used/window from sessions.list while keeping per-run message tokens", async () => {
    const runId = "run-control-ui-context";
    const sessionKey = "agent:main:fridaynext:control-ui-context";
    const gatewayRequest = vi.fn(async () => ({
      sessions: [
        {
          key: sessionKey,
          totalTokens: 19_780,
          totalTokensFresh: true,
          contextTokens: 262_144,
        },
      ],
    }));
    setFridayAgentForwardRuntime({
      runtime: {
        gateway: { isAvailable: async () => true, request: gatewayRequest },
        config: { current: () => ({ session: {} }) },
        agent: {
          session: {
            resolveStorePath: () => "/tmp/sessions.json",
            loadSessionStore: () => ({}),
          },
        },
      },
    } as never);
    registerRunRoute({ runId, deviceId: "DEVICE", sessionKey });
    setRunMetadata(runId, {
      modelName: "kimi-for-coding",
      totalTokens: 777,
    });
    markRunFinalDelivered(runId);

    scheduleLateFinalMetaPatch(runId);
    await vi.advanceTimersByTimeAsync(300);

    expect(sseEmitter.broadcastToRun).toHaveBeenCalledTimes(1);
    const event = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      data: Record<string, unknown>;
    };
    expect(event.data).toMatchObject({
      op: "final_meta",
      modelName: "kimi-for-coding",
      totalTokens: 777,
      contextTokensUsed: 19_780,
      contextWindowMax: 262_144,
    });
  });
});
