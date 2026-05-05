import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetFridayAgentForwardRuntimeForTest,
  setFridayAgentForwardRuntime,
} from "./agent-forward-runtime.js";
import {
  forwardAgentEventRaw,
  registerFridaySessionDeviceMapping,
  resetOpenClawRunDeviceMappingForTest,
  resetThinkingStreamAccumStateForTest,
} from "./friday-session.js";
import { resetRunMetadataForTest } from "./run-metadata.js";
import { sseEmitter } from "./sse/emitter.js";
import { toSessionStoreKey } from "./session/session-manager.js";

describe("forwardAgentEventRaw (thinking delta rewrite)", () => {
  const runId = "run-thinking-test";
  const sessionKey = "agent:main:friday-session-test";
  const deviceId = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

  beforeEach(() => {
    sseEmitter.resetForTest();
    resetThinkingStreamAccumStateForTest();
    resetOpenClawRunDeviceMappingForTest();
    resetFridayAgentForwardRuntimeForTest();
    resetRunMetadataForTest();
    registerFridaySessionDeviceMapping(sessionKey, deviceId);
    vi.spyOn(sseEmitter, "broadcastToRun").mockImplementation(() => {});
  });

  afterEach(() => {
    resetFridayAgentForwardRuntimeForTest();
    vi.restoreAllMocks();
  });

  it("rewrites cumulative thinking into incremental delta + reasoningPrefixChars", () => {
    const t1 = "Reasoning:\n_A_";
    const t2 = "Reasoning:\n_AB_";
    forwardAgentEventRaw({
      runId,
      seq: 1,
      ts: 100,
      stream: "thinking",
      sessionKey,
      data: { text: t1, delta: t1 },
    });
    forwardAgentEventRaw({
      runId,
      seq: 2,
      ts: 101,
      stream: "thinking",
      sessionKey,
      data: { text: t2, delta: t2 },
    });

    expect(sseEmitter.broadcastToRun).toHaveBeenCalledTimes(2);
    const first = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[0][1].data.data;
    const second = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[1][1].data.data;

    expect(first.text).toBe(t1);
    expect(first.delta).toBe(t1);
    expect(first.reasoningPrefixChars).toBe(0);

    expect(second.text).toBe(t2);
    expect(second.delta).toBe("B_");
    expect(second.reasoningPrefixChars).toBe(commonPrefixLen(t1, t2));
    expect(t2.startsWith(t1.slice(0, second.reasoningPrefixChars))).toBe(true);
  });

  it("clears per-run cache on lifecycle end so the next thinking frame is full delta again", () => {
    const t1 = "Reasoning:\n_x_";
    forwardAgentEventRaw({
      runId,
      seq: 1,
      stream: "thinking",
      sessionKey,
      data: { text: t1, delta: t1 },
    });
    forwardAgentEventRaw({
      runId,
      seq: 2,
      stream: "lifecycle",
      sessionKey,
      data: { phase: "end" },
    });
    forwardAgentEventRaw({
      runId,
      seq: 3,
      stream: "thinking",
      sessionKey,
      data: { text: t1, delta: t1 },
    });

    expect(sseEmitter.broadcastToRun).toHaveBeenCalledTimes(3);
    const third = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[2][1].data.data;
    expect(third.delta).toBe(t1);
    expect(third.reasoningPrefixChars).toBe(0);
  });

  it("clears per-run cache on lifecycle error", () => {
    const t1 = "Reasoning:\n_y_";
    forwardAgentEventRaw({
      runId,
      seq: 1,
      stream: "thinking",
      sessionKey,
      data: { text: t1, delta: t1 },
    });
    forwardAgentEventRaw({
      runId,
      seq: 2,
      stream: "lifecycle",
      sessionKey,
      data: { phase: "error" },
    });
    forwardAgentEventRaw({
      runId,
      seq: 3,
      stream: "thinking",
      sessionKey,
      data: { text: t1, delta: t1 },
    });

    const third = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[2][1].data.data;
    expect(third.reasoningPrefixChars).toBe(0);
    expect(third.delta).toBe(t1);
  });

  it("merges run metadata into lifecycle.end (model, tokens, context usage)", () => {
    forwardAgentEventRaw({
      runId,
      seq: 1,
      stream: "assistant",
      sessionKey,
      data: {
        modelName: "gpt-test",
        usage: { input: 100, output: 50, total: 150 },
        contextWindow: 128000,
      },
    });
    forwardAgentEventRaw({
      runId,
      seq: 2,
      stream: "lifecycle",
      sessionKey,
      data: { phase: "end", endedAt: 1 },
    });
    const endCall = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[1] as { data?: { stream?: string } }).data?.stream === "lifecycle",
    );
    expect(endCall).toBeTruthy();
    const data = (endCall![1] as { data: { data: Record<string, unknown> } }).data.data;
    expect(data.phase).toBe("end");
    expect(data.modelName).toBe("gpt-test");
    expect(data.totalTokens).toBe(150);
    expect(data.contextTokensUsed).toBe(100);
    expect(data.contextWindowMax).toBe(128000);
  });

  it("forwards lifecycle.end when sessionKey and run context are missing but run was mapped earlier", () => {
    const clientRun = "client-post-run-id";
    sseEmitter.trackDeviceForRun(deviceId.toUpperCase(), clientRun);

    forwardAgentEventRaw({
      runId,
      seq: 1,
      stream: "lifecycle",
      sessionKey,
      data: { phase: "start" },
    });

    forwardAgentEventRaw({
      runId,
      seq: 2,
      stream: "lifecycle",
      data: { phase: "end" },
    });

    expect(sseEmitter.broadcastToRun).toHaveBeenCalledTimes(2);
    const endPayload = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[1][1].data;
    expect(endPayload.stream).toBe("lifecycle");
    expect((endPayload.data as { phase?: string }).phase).toBe("end");
    expect(endPayload.sessionKey).toBe(sessionKey);
  });

  it("passes through non-thinking streams without rewriting data", () => {
    const data = { phase: "delta", text: "hello" };
    forwardAgentEventRaw({
      runId,
      seq: 10,
      stream: "assistant",
      sessionKey,
      data,
    });
    expect(sseEmitter.broadcastToRun).toHaveBeenCalledTimes(1);
    const payload = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[0][1].data;
    expect(payload.data).toStrictEqual(data);
    expect("reasoningPrefixChars" in (payload.data as object)).toBe(false);
  });

  it("merges sessionUsage from session store on lifecycle end after persist (deferred)", async () => {
    const storeKey = toSessionStoreKey(sessionKey);
    const store: Record<string, Record<string, unknown>> = {
      [storeKey]: {
        model: "my-model",
        modelProvider: "openai",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 9999,
        totalTokensFresh: true,
        contextTokens: 128000,
        estimatedCostUsd: 0.01,
        cacheRead: 10,
        cacheWrite: 0,
      },
    };
    const loadSessionStore = vi.fn(() => store);
    const mockApi = {
      runtime: {
        config: {
          current: () => ({ session: {} }),
        },
        agent: {
          session: {
            resolveStorePath: () => "/tmp/sessions.json",
            loadSessionStore,
          },
        },
      },
    };
    setFridayAgentForwardRuntime(mockApi as never);

    forwardAgentEventRaw({
      runId,
      seq: 1,
      stream: "lifecycle",
      sessionKey,
      data: { phase: "end" },
    });
    expect(sseEmitter.broadcastToRun).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sseEmitter.broadcastToRun).toHaveBeenCalledTimes(1);
    const forwarded = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[0][1].data;
    expect(forwarded.stream).toBe("lifecycle");
    expect((forwarded.data as Record<string, unknown>).sessionUsage).toEqual({
      modelId: "my-model",
      modelProvider: "openai",
      tokens: {
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 0,
        total: 9999,
        totalFresh: true,
      },
      context: { windowMax: 128000, used: 9999 },
      estimatedCostUsd: 0.01,
    });
    expect(loadSessionStore).toHaveBeenCalledWith("/tmp/sessions.json", { skipCache: true });
  });
});

function commonPrefixLen(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}
