/**
 * Subagent SSE smoke test — simulates the Friday iOS app connecting and
 * receiving a complete subagent lifecycle via sessions_spawn tool events.
 *
 * Run with:
 *   pnpm vitest run --config vitest.e2e.config.ts src/e2e/subagent-smoke.e2e.test.ts --reporter verbose
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createAppSimulator } from "../test-support/app-simulator.js";
import { createTempHistoryDir, setMockRuntime } from "../test-support/mock-runtime.js";
import {
  ensureSubagentFromSpawnTool,
  resetForTest as resetSubagentRegistry,
} from "../agent/subagent-registry.js";
import { forwardAgentEventRaw, registerFridaySessionDeviceMapping } from "../friday-session.js";
import { sseEmitter } from "../sse/emitter.js";

const deviceId = "IOS-DEVICE-AAAA-BBBB-CCCC-DDDD";
const mainSessionKey = "agent:main:main";
const mainRunId = "main-run-001";

function spawnResult(childSessionKey: string, runId: string, taskName: string) {
  return {
    childSessionKey,
    runId,
    taskName,
  };
}

function describeFrame(frame: { event?: string; data?: Record<string, unknown> }) {
  const event = frame.event ?? "?";
  const data = frame.data ?? {};
  switch (event) {
    case "connected":
      return `connected  deviceId=${data.deviceId} lastSeq=${data.lastSeq}`;
    case "subagent": {
      const extra =
        data.phase === "ended" ? ` outcome=${data.outcome} error=${data.error ?? "-"}` : "";
      return `subagent   phase=${data.phase} runId=${data.runId ?? "(pending)"} label=${data.label ?? "-"} parentRunId=${data.parentRunId ?? "-"} depth=${data.depth}${extra}`;
    }
    case "agent": {
      const sub = data.subagent as Record<string, unknown> | undefined;
      const subTag = sub
        ? ` SUB="agent:${sub.label ?? "?"}" depth=${sub.depth} parent=${sub.parentRunId ?? "-"}`
        : " (main)";
      const inner = (data.data ?? {}) as Record<string, unknown>;
      let detail = "";
      if (data.stream === "thinking")
        detail = ` thinking: "${String(inner.text ?? "").slice(0, 50)}"`;
      else if (data.stream === "tool") detail = ` tool=${inner.name ?? "?"} phase=${inner.phase}`;
      else if (data.stream === "assistant")
        detail = ` text="${String(inner.text ?? inner.phase ?? "")}"`;
      else if (data.stream === "lifecycle") detail = ` phase=${inner.phase}`;
      return `agent      stream=${data.stream} runId=${String(data.runId).slice(0, 30)}…${subTag}${detail}`;
    }
    default:
      return `${event}`;
  }
}

describe("subagent smoke", () => {
  let historyDir = "";

  beforeEach(() => {
    historyDir = createTempHistoryDir();
    setMockRuntime({ historyDir, authToken: "smoke-token" });
    resetSubagentRegistry();
  });

  it("full nested subagent lifecycle via sessions_spawn tool events", async () => {
    const app = createAppSimulator({ token: "smoke-token", deviceId });
    await app.connectSSE();
    registerFridaySessionDeviceMapping(mainSessionKey, deviceId);

    // ── Main run lifecycle start ──────────────────────────
    forwardAgentEventRaw({
      runId: mainRunId,
      seq: 1,
      stream: "lifecycle",
      sessionKey: mainSessionKey,
      data: { phase: "start" },
    });

    // ── Subagent A: tool.start (spawning) ─────────────────
    const childKeyA = "agent:main:subagent:code-reviewer";
    const bareA = "bare-run-reviewer";
    const compoundA = `announce:v1:${childKeyA}:${bareA}`;

    forwardAgentEventRaw({
      runId: mainRunId,
      seq: 2,
      stream: "tool",
      sessionKey: mainSessionKey,
      data: {
        phase: "start",
        name: "sessions_spawn",
        toolCallId: "call_a",
        args: { taskName: "code-reviewer" },
      },
    });

    // ── Subagent A: tool.result (spawned) ─────────────────
    forwardAgentEventRaw({
      runId: mainRunId,
      seq: 3,
      stream: "tool",
      sessionKey: mainSessionKey,
      data: {
        phase: "result",
        name: "sessions_spawn",
        toolCallId: "call_1",
        meta: "code-reviewer",
        result: { details: spawnResult(childKeyA, bareA, "code-reviewer") },
      },
    });
    sseEmitter.trackDeviceForRun(deviceId, compoundA);

    // ── Subagent A: agent events (subagent's own sessionKey) ─
    forwardAgentEventRaw({
      runId: compoundA,
      seq: 1,
      stream: "lifecycle",
      data: { phase: "start" },
      sessionKey: childKeyA,
    });
    forwardAgentEventRaw({
      runId: compoundA,
      seq: 2,
      stream: "thinking",
      data: {
        text: "Let me review the code for issues…",
        delta: "Let me review the code for issues…",
        reasoningPrefixChars: 0,
      },
      sessionKey: childKeyA,
    });
    forwardAgentEventRaw({
      runId: compoundA,
      seq: 3,
      stream: "tool",
      data: { phase: "start", name: "read", args: { path: "src/app.ts" } },
      sessionKey: childKeyA,
    });
    forwardAgentEventRaw({
      runId: compoundA,
      seq: 4,
      stream: "tool",
      data: { phase: "result", name: "read", result: "file contents…" },
      sessionKey: childKeyA,
    });
    forwardAgentEventRaw({
      runId: compoundA,
      seq: 5,
      stream: "assistant",
      data: { phase: "delta", text: "Found 3 issues in the code." },
      sessionKey: childKeyA,
    });

    // ── Nested: Subagent B spawning + spawned ────────────
    const childKeyB = "agent:main:subagent:lint";
    const bareB = "bare-run-lint";
    const compoundB = `announce:v1:${childKeyB}:${bareB}`;

    forwardAgentEventRaw({
      runId: compoundA,
      seq: 7,
      stream: "tool",
      sessionKey: mainSessionKey,
      data: {
        phase: "start",
        name: "sessions_spawn",
        toolCallId: "call_b",
        args: { taskName: "lint" },
      },
    });

    forwardAgentEventRaw({
      runId: compoundA,
      seq: 8,
      stream: "tool",
      sessionKey: mainSessionKey,
      data: {
        phase: "result",
        name: "sessions_spawn",
        toolCallId: "call_2",
        meta: "lint",
        result: { details: spawnResult(childKeyB, bareB, "lint") },
      },
    });
    sseEmitter.trackDeviceForRun(deviceId, compoundB);

    // ── Subagent B: agent event (subagent's own sessionKey) ─
    forwardAgentEventRaw({
      runId: compoundB,
      seq: 1,
      stream: "assistant",
      data: { phase: "delta", text: "No lint errors found." },
      sessionKey: childKeyB,
    });

    // ── Subagent B ended (subagent's own sessionKey) ──────
    forwardAgentEventRaw({
      runId: compoundB,
      seq: 2,
      stream: "lifecycle",
      data: { phase: "end" },
      sessionKey: childKeyB,
    });

    // ── Subagent A ended (subagent's own sessionKey) ──────
    forwardAgentEventRaw({
      runId: compoundA,
      seq: 7,
      stream: "lifecycle",
      data: { phase: "end" },
      sessionKey: childKeyA,
    });

    // Wait for SSE flush
    await new Promise((r) => setTimeout(r, 50));
    const frames = app.getSseFrames();

    // ── Verbose output ──────────────────────────────────
    console.log("\n══════════════════════════════════════════════════════");
    console.log("  SSE Frames (as received by the iOS app)");
    console.log("══════════════════════════════════════════════════════\n");
    for (const frame of frames) {
      console.log(`[${String(frame.id ?? "-").padStart(3)}] ${describeFrame(frame)}`);
    }
    console.log("\n══════════════════════════════════════════════════════");
    const subagentCount = frames.filter((f) => f.event === "subagent").length;
    const annotatedCount = frames.filter(
      (f) => f.event === "agent" && f.data?.subagent != null,
    ).length;
    console.log(`  Totals: ${frames.length} frames`);
    console.log(`    subagent lifecycle events: ${subagentCount}`);
    console.log(`    agent events with subagent annotation: ${annotatedCount}`);
    console.log("══════════════════════════════════════════════════════\n");

    // ── Assertions ──────────────────────────────────────
    expect(subagentCount).toBeGreaterThanOrEqual(6); // 2 spawning + 2 spawned + 2 ended
    expect(annotatedCount).toBeGreaterThanOrEqual(5);

    // Verify subagent phases
    const subagentFrames = frames.filter((f) => f.event === "subagent");
    const phases = subagentFrames.map((f) => f.data?.phase);
    expect(phases.filter((p) => p === "spawning")).toHaveLength(2);
    expect(phases.filter((p) => p === "spawned")).toHaveLength(2);
    expect(phases.filter((p) => p === "ended")).toHaveLength(2);

    // Verify annotation only on subagent events
    for (const f of frames) {
      if (f.event !== "agent") continue;
      const hasSub = f.data?.subagent != null;
      const runId = f.data?.runId as string | undefined;
      if (runId === mainRunId) {
        expect(hasSub, `main agent annotated: ${describeFrame(f)}`).toBe(false);
      }
    }

    app.disconnectSSE();
  });
});
