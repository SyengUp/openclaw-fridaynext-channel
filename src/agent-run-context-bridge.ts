/**
 * Read OpenClaw agent run context (sessionKey, …) from the same global singleton
 * as `src/infra/agent-events.ts` (`Symbol.for("openclaw.agentEvents.state")`).
 *
 * When a run is hidden from Control UI, `emitAgentEvent` strips `sessionKey` from
 * the listener payload, but `runContextById` still holds it — we need that for
 * Friday SSE and tool hooks without importing the `openclaw` package from this folder.
 */

const AGENT_EVENT_STATE_KEY = Symbol.for("openclaw.agentEvents.state");

export type OpenClawAgentRunContextBridge = {
  sessionKey?: string;
  isControlUiVisible?: boolean;
};

type AgentEventStateLike = {
  runContextById: Map<string, OpenClawAgentRunContextBridge>;
};

function getAgentEventState(): AgentEventStateLike | undefined {
  const raw = (globalThis as Record<PropertyKey, unknown>)[AGENT_EVENT_STATE_KEY];
  if (!raw || typeof raw !== "object") return undefined;
  const runContextById = (raw as { runContextById?: unknown }).runContextById;
  if (!(runContextById instanceof Map)) return undefined;
  return { runContextById };
}

export function getOpenClawAgentRunContext(
  runId: string,
): OpenClawAgentRunContextBridge | undefined {
  if (!runId) return undefined;
  return getAgentEventState()?.runContextById.get(runId);
}
