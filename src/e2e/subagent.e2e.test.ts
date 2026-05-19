import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureSubagentFromSpawnTool,
  registerEnded,
  lookupByRunId,
  lookupByChildSessionKey,
  resetForTest as resetSubagentRegistryForTest,
  registerSessionKeyForRun,
} from "../agent/subagent-registry.js";
import {
  forwardAgentEventRaw,
  registerFridaySessionDeviceMapping,
  resetOpenClawRunDeviceMappingForTest,
  resetThinkingStreamAccumStateForTest,
} from "../friday-session.js";
import { resetFridayAgentForwardRuntimeForTest } from "../agent-forward-runtime.js";
import { sseEmitter } from "../sse/emitter.js";
import { resetRunMetadataForTest } from "../run-metadata.js";
import { resetActiveRunsForTest } from "../agent/active-runs.js";

const deviceId = "DEVICE-AAAA-BBBB";
const mainSessionKey = "agent:main:main";
const mainRunId = "main-run-001";

function captureBroadcastToRunCalls() {
  const calls: Array<[string, { type: string; data: Record<string, unknown> }]> = [];
  vi.spyOn(sseEmitter, "broadcastToRun").mockImplementation((runId, event) => {
    calls.push([runId, event]);
  });
  return calls;
}

function captureBroadcastCalls() {
  const calls: Array<[string | undefined, { type: string; data: Record<string, unknown> }]> = [];
  vi.spyOn(sseEmitter, "broadcast").mockImplementation((event, deviceId) => {
    calls.push([deviceId, event]);
  });
  return calls;
}

function makeSpawnToolResult(params: {
  childSessionKey: string;
  runId?: string;
  taskName?: string;
  meta?: string;
}) {
  return {
    childSessionKey: params.childSessionKey,
    runId: params.runId ?? "bare-run-001",
    taskName: params.taskName ?? "task",
  };
}

describe("subagent via sessions_spawn tool", () => {
  beforeEach(() => {
    sseEmitter.resetForTest();
    resetSubagentRegistryForTest();
    resetThinkingStreamAccumStateForTest();
    resetOpenClawRunDeviceMappingForTest();
    resetRunMetadataForTest();
    resetActiveRunsForTest();
    resetFridayAgentForwardRuntimeForTest();
    registerFridaySessionDeviceMapping(mainSessionKey, deviceId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("registry (tool-driven API)", () => {
    it("ensureSubagentFromSpawnTool creates entry with parentRunId", () => {
      registerSessionKeyForRun(mainSessionKey, mainRunId);

      const entry = ensureSubagentFromSpawnTool({
        childSessionKey: "agent:main:subagent:cr",
        bareRunId: "run-cr",
        label: "code-reviewer",
        deviceId,
        parentRunId: mainRunId,
        requesterSessionKey: mainSessionKey,
      });

      expect(entry.status).toBe("running");
      expect(entry.depth).toBe(1);
      expect(entry.parentRunId).toBe(mainRunId);
      expect(entry.label).toBe("code-reviewer");
      expect(entry.runId).toBe("run-cr");
      expect(entry.deviceId).toBe(deviceId);
    });

    it("reuses existing entry on duplicate childSessionKey", () => {
      const e1 = ensureSubagentFromSpawnTool({
        childSessionKey: "agent:main:subagent:cr",
        bareRunId: "run-1",
        deviceId,
        parentRunId: mainRunId,
      });
      const e2 = ensureSubagentFromSpawnTool({
        childSessionKey: "agent:main:subagent:cr",
        bareRunId: "run-2",
        deviceId,
        parentRunId: mainRunId,
      });
      expect(e2).toBe(e1);
      expect(e2.runId).toBe("run-1"); // original runId preserved
    });

    it("registerEnded marks entry as ended", () => {
      const entry = ensureSubagentFromSpawnTool({
        childSessionKey: "agent:main:subagent:cr",
        bareRunId: "run-cr",
        deviceId,
        parentRunId: mainRunId,
      });
      const ended = registerEnded({ runId: "run-cr", outcome: "error", error: "timeout" });
      expect(ended?.status).toBe("ended");
      expect(ended?.outcome).toBe("error");
      expect(ended?.error).toBe("timeout");
    });

    it("registerEnded finds entry by childSessionKey", () => {
      ensureSubagentFromSpawnTool({
        childSessionKey: "agent:main:subagent:cr",
        bareRunId: "run-cr",
        deviceId,
        parentRunId: mainRunId,
      });
      const ended = registerEnded({ childSessionKey: "agent:main:subagent:cr", outcome: "ok" });
      expect(ended?.status).toBe("ended");
    });

    it("registerEnded returns undefined for unknown keys", () => {
      expect(registerEnded({ runId: "nonexistent" })).toBeUndefined();
    });
  });

  describe("announce runId parsing", () => {
    it("lookupByRunId resolves compound announce runIds", () => {
      ensureSubagentFromSpawnTool({
        childSessionKey: "agent:main:subagent:abc-123",
        bareRunId: "bare-id",
        deviceId,
        parentRunId: mainRunId,
      });
      const compound = "announce:v1:agent:main:subagent:abc-123:bare-id";
      const entry = lookupByRunId(compound);
      expect(entry).toBeTruthy();
      expect(entry?.childSessionKey).toBe("agent:main:subagent:abc-123");
    });

    it("lookupByRunId resolves bare runIds", () => {
      ensureSubagentFromSpawnTool({
        childSessionKey: "agent:main:subagent:xyz",
        bareRunId: "bare-xyz",
        deviceId,
        parentRunId: mainRunId,
      });
      const entry = lookupByRunId("bare-xyz");
      expect(entry).toBeTruthy();
      expect(entry?.childSessionKey).toBe("agent:main:subagent:xyz");
    });

    it("lookupByRunId returns undefined for unknown runIds", () => {
      expect(lookupByRunId("unknown-run")).toBeUndefined();
    });
  });

  describe("nested subagents", () => {
    it("resolves depth=2 for nested subagent via requesterSessionKey chain", () => {
      const childKeyA = "agent:main:subagent:reviewer";
      const childRunA = "run-reviewer";

      registerSessionKeyForRun(mainSessionKey, mainRunId);

      ensureSubagentFromSpawnTool({
        childSessionKey: childKeyA,
        bareRunId: childRunA,
        deviceId,
        label: "reviewer",
        parentRunId: mainRunId,
        requesterSessionKey: mainSessionKey,
      });

      // Nested subagent B spawns with requesterSessionKey = A's childSessionKey
      const entryB = ensureSubagentFromSpawnTool({
        childSessionKey: "agent:main:subagent:lint",
        bareRunId: "run-lint",
        deviceId,
        label: "lint",
        parentRunId: childRunA,
        requesterSessionKey: childKeyA,
      });

      expect(entryB.depth).toBe(2);
      expect(entryB.parentRunId).toBe(childRunA);
    });
  });

  describe("forwardAgentEventRaw integration", () => {
    it("sessions_spawn tool result triggers subagent SSE emission", () => {
      const childKey = "agent:main:subagent:cr";
      const childRun = "bare-run-cr";

      // Main run start
      forwardAgentEventRaw({
        runId: mainRunId, seq: 1, stream: "lifecycle",
        sessionKey: mainSessionKey, data: { phase: "start" },
      });

      const broadcastCalls = captureBroadcastCalls();

      // Simulate sessions_spawn tool result
      forwardAgentEventRaw({
        runId: mainRunId, seq: 2, stream: "tool",
        sessionKey: mainSessionKey,
        data: {
          phase: "result",
          name: "sessions_spawn",
          toolCallId: "call_1",
          result: {
            details: makeSpawnToolResult({
              childSessionKey: childKey,
              runId: childRun,
              taskName: "code-reviewer",
            }),
          },
        },
      });

      // Should emit subagent SSE with phase=spawned
      const subagentCalls = broadcastCalls.filter(([, e]) => e.type === "subagent");
      expect(subagentCalls).toHaveLength(1);
      expect(subagentCalls[0]![1].data.phase).toBe("spawned");
      expect(subagentCalls[0]![1].data.childSessionKey).toBe(childKey);
      expect(subagentCalls[0]![1].data.label).toBe("code-reviewer");
      expect(subagentCalls[0]![1].data.parentRunId).toBe(mainRunId);
      expect(subagentCalls[0]![1].data.depth).toBe(1);
    });

    it("agent events for subagent runId are annotated via announce runId", () => {
      const childKey = "agent:main:subagent:cr";
      const bareRunId = "bare-cr";

      // Main run
      forwardAgentEventRaw({
        runId: mainRunId, seq: 1, stream: "lifecycle",
        sessionKey: mainSessionKey, data: { phase: "start" },
      });

      // Spawn subagent
      forwardAgentEventRaw({
        runId: mainRunId, seq: 2, stream: "tool",
        sessionKey: mainSessionKey,
        data: {
          phase: "result", name: "sessions_spawn", toolCallId: "c1",
          result: { details: makeSpawnToolResult({ childSessionKey: childKey, runId: bareRunId, taskName: "cr" }) },
        },
      });

      const compoundRunId = `announce:v1:${childKey}:${bareRunId}`;
      sseEmitter.trackDeviceForRun(deviceId, compoundRunId);

      const calls = captureBroadcastToRunCalls();

      // Agent event for subagent (announce runId, subagent's own sessionKey)
      forwardAgentEventRaw({
        runId: compoundRunId, seq: 1, stream: "thinking",
        data: { text: "reviewing..." },
        sessionKey: childKey,
      });

      const agentCall = calls.find(
        ([, e]) => e.type === "agent" && e.data.stream === "thinking",
      );
      expect(agentCall).toBeTruthy();
      expect(agentCall![1].data.subagent).toEqual({
        label: "cr",
        parentRunId: mainRunId,
        depth: 1,
      });
    });

    it("main agent events are NOT annotated", () => {
      forwardAgentEventRaw({
        runId: mainRunId, seq: 1, stream: "lifecycle",
        sessionKey: mainSessionKey, data: { phase: "start" },
      });

      const calls = captureBroadcastToRunCalls();

      forwardAgentEventRaw({
        runId: mainRunId, seq: 2, stream: "assistant",
        sessionKey: mainSessionKey,
        data: { text: "main reply" },
      });

      const agentCall = calls.find(
        ([, e]) => e.type === "agent" && e.data.stream === "assistant",
      );
      expect(agentCall![1].data.subagent).toBeUndefined();
    });

    it("lifecycle end for subagent emits ended SSE", () => {
      const childKey = "agent:main:subagent:cr";
      const bareRunId = "bare-cr";

      forwardAgentEventRaw({
        runId: mainRunId, seq: 1, stream: "lifecycle",
        sessionKey: mainSessionKey, data: { phase: "start" },
      });

      forwardAgentEventRaw({
        runId: mainRunId, seq: 2, stream: "tool",
        sessionKey: mainSessionKey,
        data: {
          phase: "result", name: "sessions_spawn", toolCallId: "c1",
          result: { details: makeSpawnToolResult({ childSessionKey: childKey, runId: bareRunId, taskName: "cr" }) },
        },
      });

      const compoundRunId = `announce:v1:${childKey}:${bareRunId}`;
      sseEmitter.trackDeviceForRun(deviceId, compoundRunId);

      const broadcastCalls = captureBroadcastCalls();

      // Lifecycle end for subagent (subagent's own sessionKey)
      forwardAgentEventRaw({
        runId: compoundRunId, seq: 5, stream: "lifecycle",
        data: { phase: "end" },
        sessionKey: childKey,
      });

      const endedCall = broadcastCalls.find(
        ([, e]) => e.type === "subagent" && e.data.phase === "ended",
      );
      expect(endedCall).toBeTruthy();
      expect(endedCall![1].data.outcome).toBe("ok");
    });

    it("lifecycle error for subagent emits ended SSE with error outcome", () => {
      const childKey = "agent:main:subagent:cr";
      const bareRunId = "bare-cr";

      forwardAgentEventRaw({
        runId: mainRunId, seq: 1, stream: "lifecycle",
        sessionKey: mainSessionKey, data: { phase: "start" },
      });

      forwardAgentEventRaw({
        runId: mainRunId, seq: 2, stream: "tool",
        sessionKey: mainSessionKey,
        data: {
          phase: "result", name: "sessions_spawn", toolCallId: "c1",
          result: { details: makeSpawnToolResult({ childSessionKey: childKey, runId: bareRunId }) },
        },
      });

      const compoundRunId = `announce:v1:${childKey}:${bareRunId}`;
      sseEmitter.trackDeviceForRun(deviceId, compoundRunId);

      const broadcastCalls = captureBroadcastCalls();

      forwardAgentEventRaw({
        runId: compoundRunId, seq: 5, stream: "lifecycle",
        data: { phase: "error", error: "timeout" },
        sessionKey: childKey,
      });

      const endedCall = broadcastCalls.find(
        ([, e]) => e.type === "subagent" && e.data.phase === "ended",
      );
      expect(endedCall).toBeTruthy();
      expect(endedCall![1].data.outcome).toBe("error");
      expect(endedCall![1].data.error).toBe("timeout");
    });

    it("duplicate lifecycle end does not emit a second ended SSE", () => {
      const childKey = "agent:main:subagent:cr";
      const bareRunId = "bare-cr";

      forwardAgentEventRaw({
        runId: mainRunId, seq: 1, stream: "lifecycle",
        sessionKey: mainSessionKey, data: { phase: "start" },
      });

      forwardAgentEventRaw({
        runId: mainRunId, seq: 2, stream: "tool",
        sessionKey: mainSessionKey,
        data: {
          phase: "result", name: "sessions_spawn", toolCallId: "c1",
          result: { details: makeSpawnToolResult({ childSessionKey: childKey, runId: bareRunId }) },
        },
      });

      const compoundRunId = `announce:v1:${childKey}:${bareRunId}`;
      sseEmitter.trackDeviceForRun(deviceId, compoundRunId);

      const broadcastCalls = captureBroadcastCalls();

      forwardAgentEventRaw({
        runId: compoundRunId, seq: 5, stream: "lifecycle",
        data: { phase: "end" },
        sessionKey: childKey,
      });
      forwardAgentEventRaw({
        runId: compoundRunId, seq: 6, stream: "lifecycle",
        data: { phase: "end" },
        sessionKey: childKey,
      });

      const endedCalls = broadcastCalls.filter(
        ([, e]) => e.type === "subagent" && e.data.phase === "ended",
      );
      expect(endedCalls).toHaveLength(1); // only first end counts
    });
  });

  describe("complete tool-driven lifecycle", () => {
    it("two-level nested subagent via sessions_spawn events", () => {
      const childKeyA = "agent:main:subagent:reviewer";
      const bareA = "bare-reviewer";
      const compoundA = `announce:v1:${childKeyA}:${bareA}`;
      const childKeyB = "agent:main:subagent:lint";
      const bareB = "bare-lint";
      const compoundB = `announce:v1:${childKeyB}:${bareB}`;

      // Main run start
      forwardAgentEventRaw({
        runId: mainRunId, seq: 1, stream: "lifecycle",
        sessionKey: mainSessionKey, data: { phase: "start" },
      });

      // sessions_spawn for A
      forwardAgentEventRaw({
        runId: mainRunId, seq: 2, stream: "tool",
        sessionKey: mainSessionKey,
        data: {
          phase: "result", name: "sessions_spawn", toolCallId: "c1",
          result: { details: makeSpawnToolResult({ childSessionKey: childKeyA, runId: bareA, taskName: "reviewer" }) },
        },
      });
      sseEmitter.trackDeviceForRun(deviceId, compoundA);

      // Subagent A thinking (subagent's own sessionKey)
      const calls = captureBroadcastToRunCalls();
      forwardAgentEventRaw({
        runId: compoundA, seq: 1, stream: "thinking",
        data: { text: "reviewing code..." },
        sessionKey: childKeyA,
      });
      const thinkingA = calls.find(
        ([, e]) => e.type === "agent" && e.data.stream === "thinking",
      );
      expect(thinkingA![1].data.subagent).toEqual({
        label: "reviewer",
        parentRunId: mainRunId,
        depth: 1,
      });

      // sessions_spawn for B (nested from A's tool call — but parentRunId should come from the context)
      // In reality, B is spawned from a tool call inside A's run, but here we simulate it from the main run
      // The registry handles nesting via requesterSessionKey chain
      forwardAgentEventRaw({
        runId: compoundA, seq: 2, stream: "tool",
        sessionKey: mainSessionKey,
        data: {
          phase: "result", name: "sessions_spawn", toolCallId: "c2",
          result: { details: makeSpawnToolResult({ childSessionKey: childKeyB, runId: bareB, taskName: "lint" }) },
        },
      });
      sseEmitter.trackDeviceForRun(deviceId, compoundB);

      // Subagent B thinking (subagent's own sessionKey)
      forwardAgentEventRaw({
        runId: compoundB, seq: 1, stream: "assistant",
        data: { text: "no lint errors" },
        sessionKey: childKeyB,
      });
      const assistantB = calls.find(
        ([, e]) => e.type === "agent" && e.data.stream === "assistant",
      );
      expect(assistantB![1].data.subagent).toBeDefined();

      // B ends (subagent's own sessionKey)
      forwardAgentEventRaw({
        runId: compoundB, seq: 5, stream: "lifecycle",
        data: { phase: "end" },
        sessionKey: childKeyB,
      });

      // A ends (subagent's own sessionKey)
      forwardAgentEventRaw({
        runId: compoundA, seq: 6, stream: "lifecycle",
        data: { phase: "end" },
        sessionKey: childKeyA,
      });

      expect(lookupByChildSessionKey(childKeyA)?.status).toBe("ended");
      expect(lookupByChildSessionKey(childKeyB)?.status).toBe("ended");
    });
  });
});
