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
import {
  accumulateRunUsage,
  resetRunUsageAccumulatorForTest,
} from "./agent/run-usage-accumulator.js";
import { sseEmitter } from "./sse/emitter.js";
import { toSessionStoreKey } from "./session/session-manager.js";
import {
  ensureSubagentFromSpawnTool,
  resetForTest as resetSubagentRegistryForTest,
} from "./agent/subagent-registry.js";

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
    resetRunUsageAccumulatorForTest();
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
    const first = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[0][1].data
      .data;
    const second = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[1][1].data
      .data;

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
    const third = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[2][1].data
      .data;
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

    const third = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[2][1].data
      .data;
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
    const endPayload = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[1][1]
      .data;
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

  it("builds sessionUsage from store (cumulative) with llm_output fallback", async () => {
    // No store entry — falls back to llm_output per-run data.
    setFridayAgentForwardRuntime({
      runtime: {
        config: { current: () => ({ session: {} }) },
        agent: {
          session: {
            resolveStorePath: () => "/tmp/sessions.json",
            loadSessionStore: vi.fn(() => ({})),
          },
        },
      },
    } as never);

    accumulateRunUsage(
      runId,
      { input: 100, output: 50, cacheRead: 10, total: 150 },
      "my-model",
      "openai",
    );
    accumulateRunUsage(
      runId,
      { input: 30, output: 10, cacheRead: 0, total: 40 },
      "my-model",
      "openai",
    );

    forwardAgentEventRaw({
      runId,
      seq: 1,
      stream: "lifecycle",
      sessionKey,
      data: { phase: "end" },
    });

    // Deferred 100ms — not broadcast yet.
    expect(sseEmitter.broadcastToRun).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setTimeout(resolve, 150));

    expect(sseEmitter.broadcastToRun).toHaveBeenCalledTimes(1);
    const forwarded = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[0][1].data;
    expect(forwarded.stream).toBe("lifecycle");
    const sessionUsage = (forwarded.data as Record<string, unknown>).sessionUsage as Record<
      string,
      unknown
    >;
    expect(sessionUsage).toBeDefined();
    // llm_output fallback — per-run totals.
    expect(sessionUsage.modelId).toBe("my-model");
    expect(sessionUsage.modelProvider).toBe("openai");
    expect((sessionUsage.tokens as Record<string, unknown>).input).toBe(130);
    expect((sessionUsage.tokens as Record<string, unknown>).output).toBe(60);
    expect((sessionUsage.tokens as Record<string, unknown>).cacheRead).toBe(10);
    expect((sessionUsage.tokens as Record<string, unknown>).total).toBe(190);
    expect((sessionUsage.tokens as Record<string, unknown>).totalFresh).toBe(true);
  });

  it("prefers store cumulative totals over llm_output per-run data", async () => {
    const storeKey = toSessionStoreKey(sessionKey);
    setFridayAgentForwardRuntime({
      runtime: {
        config: { current: () => ({ session: {} }) },
        agent: {
          session: {
            resolveStorePath: () => "/tmp/sessions.json",
            loadSessionStore: vi.fn(() => ({
              [storeKey]: {
                model: "store-model",
                modelProvider: "old-provider",
                inputTokens: 5000,
                outputTokens: 2000,
                totalTokens: 99999,
                totalTokensFresh: true,
                contextTokens: 128000,
                estimatedCostUsd: 0.05,
                cacheRead: 100,
                cacheWrite: 50,
              },
            })),
          },
        },
      },
    } as never);

    // llm_output has fresher model/provider but per-run (smaller) tokens.
    accumulateRunUsage(
      runId,
      { input: 500, output: 100, cacheRead: 200, total: 800 },
      "llm-model",
      "llm-provider",
    );

    forwardAgentEventRaw({
      runId,
      seq: 1,
      stream: "lifecycle",
      sessionKey,
      data: { phase: "end" },
    });

    expect(sseEmitter.broadcastToRun).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setTimeout(resolve, 150));

    expect(sseEmitter.broadcastToRun).toHaveBeenCalledTimes(1);
    const forwarded = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[0][1].data;
    const sessionUsage = (forwarded.data as Record<string, unknown>).sessionUsage as Record<
      string,
      unknown
    >;
    expect(sessionUsage).toBeDefined();
    // Store cumulative totals win.
    expect((sessionUsage.tokens as Record<string, unknown>).input).toBe(5000);
    expect((sessionUsage.tokens as Record<string, unknown>).output).toBe(2000);
    expect((sessionUsage.tokens as Record<string, unknown>).total).toBe(99999);
    // Model/provider from llm_output (fresher) override store.
    expect(sessionUsage.modelId).toBe("llm-model");
    expect(sessionUsage.modelProvider).toBe("llm-provider");
    expect(sessionUsage.estimatedCostUsd).toBe(0.05);
    expect((sessionUsage.context as Record<string, unknown>).windowMax).toBe(128000);
  });

  it("uses store cumulative totals when llm_output has no data", async () => {
    const storeKey = toSessionStoreKey(sessionKey);
    const store: Record<string, Record<string, unknown>> = {
      [storeKey]: {
        model: "store-model",
        modelProvider: "store-provider",
        inputTokens: 200,
        outputTokens: 80,
        totalTokens: 5000,
        totalTokensFresh: true,
        contextTokens: 64000,
        estimatedCostUsd: 0.05,
        cacheRead: 20,
        cacheWrite: 0,
      },
    };
    setFridayAgentForwardRuntime({
      runtime: {
        config: { current: () => ({ session: {} }) },
        agent: {
          session: {
            resolveStorePath: () => "/tmp/sessions.json",
            loadSessionStore: vi.fn(() => store),
          },
        },
      },
    } as never);

    // No llm_output data accumulated — store is the only token source.
    forwardAgentEventRaw({
      runId,
      seq: 1,
      stream: "lifecycle",
      sessionKey,
      data: { phase: "end" },
    });
    // Deferred: not broadcast yet (setTimeout 100ms hasn't fired).
    expect(sseEmitter.broadcastToRun).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => setTimeout(resolve, 150));

    expect(sseEmitter.broadcastToRun).toHaveBeenCalledTimes(1);
    const forwarded = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[0][1].data;
    expect(forwarded.stream).toBe("lifecycle");
    const sessionUsage = (forwarded.data as Record<string, unknown>).sessionUsage as Record<
      string,
      unknown
    >;
    expect(sessionUsage).toBeDefined();
    expect(sessionUsage.modelId).toBe("store-model");
    expect(sessionUsage.modelProvider).toBe("store-provider");
    expect((sessionUsage.tokens as Record<string, unknown>).input).toBe(200);
    expect((sessionUsage.tokens as Record<string, unknown>).output).toBe(80);
    expect((sessionUsage.tokens as Record<string, unknown>).total).toBe(5000);
    expect((sessionUsage.tokens as Record<string, unknown>).totalFresh).toBe(true);
    expect((sessionUsage.context as Record<string, unknown>).windowMax).toBe(64000);
    expect(sessionUsage.estimatedCostUsd).toBe(0.05);
  });
});

function commonPrefixLen(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

// P1 of the subagent streaming redo (see subagent-streaming-redo-plan.md):
// the plugin ships authoritative correlation keys so the app stops self-deriving identity.
describe("forwardAgentEventRaw (subagent stable-identity fields: A1/A2/A3)", () => {
  const sessionKey = "agent:main:friday-session-test";
  const deviceId = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
  const childKey = "agent:main:subagent:abc";

  type SubagentBroadcast = { type: string; data: Record<string, unknown> };

  function subagentBroadcasts(phase: string): Record<string, unknown>[] {
    return (sseEmitter.broadcast as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as SubagentBroadcast)
      .filter((m) => m.type === "subagent" && m.data.phase === phase)
      .map((m) => m.data);
  }

  beforeEach(() => {
    sseEmitter.resetForTest();
    resetThinkingStreamAccumStateForTest();
    resetOpenClawRunDeviceMappingForTest();
    resetSubagentRegistryForTest();
    registerFridaySessionDeviceMapping(sessionKey, deviceId);
    vi.spyOn(sseEmitter, "broadcastToRun").mockImplementation(() => {});
    vi.spyOn(sseEmitter, "broadcast").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A2: spawning carries the spawn tool-call id as a stable correlation key.
  it("spawning event carries the spawn toolCallId", () => {
    forwardAgentEventRaw({
      runId: "parent-run",
      seq: 1,
      stream: "tool",
      sessionKey,
      data: {
        name: "sessions_spawn",
        phase: "start",
        toolCallId: "tc-1",
        args: { taskName: "weather" },
      },
    });

    const spawning = subagentBroadcasts("spawning");
    expect(spawning).toHaveLength(1);
    expect(spawning[0].toolCallId).toBe("tc-1");
    expect(spawning[0].childSessionKey).toBeNull();
    expect(spawning[0].runId).toBeNull();
    expect(spawning[0].label).toBe("weather");
  });

  // A1: a subagent's own agent-delta is annotated with childSessionKey + status.
  it("subagent agent-delta annotation includes childSessionKey and status", () => {
    ensureSubagentFromSpawnTool({
      childSessionKey: childKey,
      bareRunId: "sub-bare",
      label: "weather",
      deviceId,
      parentRunId: "parent-run",
      requesterSessionKey: sessionKey,
    });

    forwardAgentEventRaw({
      runId: "sub-bare",
      seq: 1,
      stream: "thinking",
      sessionKey: childKey, // subagent's own event → sessionKey === childSessionKey
      data: { text: "looking up", delta: "looking up" },
    });

    expect(sseEmitter.broadcastToRun).toHaveBeenCalledTimes(1);
    const payload = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[0][1].data;
    const subagent = payload.subagent as Record<string, unknown>;
    expect(subagent).toBeDefined();
    expect(subagent.childSessionKey).toBe(childKey);
    expect(subagent.status).toBe("running");
    expect(subagent.label).toBe("weather");
    expect(subagent.parentRunId).toBe("parent-run");
  });

  // A3: the parent's announce-summary lifecycle.start emits an explicit dismiss keyed by
  // childSessionKey — replacing the app's fragile announce-runId string parsing.
  it("announce-summary lifecycle.start emits a dismissed subagent event by childSessionKey", () => {
    ensureSubagentFromSpawnTool({
      childSessionKey: childKey,
      bareRunId: "sub-bare",
      label: "weather",
      deviceId,
      parentRunId: "parent-run",
      requesterSessionKey: sessionKey,
    });

    const announceRunId = `announce:v1:${childKey}:sub-bare`;
    forwardAgentEventRaw({
      runId: announceRunId,
      seq: 1,
      stream: "lifecycle",
      sessionKey, // parent's sessionKey, not the child's
      data: { phase: "start" },
    });

    const dismissed = subagentBroadcasts("dismissed");
    expect(dismissed).toHaveLength(1);
    expect(dismissed[0].childSessionKey).toBe(childKey);
    expect(dismissed[0].runId).toBe("sub-bare");
    expect(dismissed[0].parentRunId).toBe("parent-run");
  });

  // A3 must not fire on ordinary (non-announce) lifecycle.start frames.
  it("does not emit dismissed for a normal lifecycle.start", () => {
    forwardAgentEventRaw({
      runId: "parent-run",
      seq: 1,
      stream: "lifecycle",
      sessionKey,
      data: { phase: "start" },
    });
    expect(subagentBroadcasts("dismissed")).toHaveLength(0);
  });
});
