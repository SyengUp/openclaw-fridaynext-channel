import { normalizeAgentId } from "../agent-id.js";
import { toSessionStoreKey } from "../session/session-manager.js";
import {
  abortSessionRunTargetFromCore,
  type SessionAbortOutcome,
} from "./session-abort-bridge.js";

export type AbortRunResult = { aborted: boolean };

export type AbortRunDeps = {
  resolveActiveEmbeddedRunSessionId: (sessionKey: string) => string | undefined;
  abortAgentHarnessRun: (sessionId: string) => boolean;
  /**
   * Canonical session stop (marks the reply operation `aborted_by_user` first, then
   * aborts the embedded run) — the same chain core's `/stop` uses. Optional so tests
   * can drive the legacy plain-abort path deterministically.
   */
  abortSessionRunTarget?: (params: {
    sessionKey: string;
    agentId: string;
  }) => Promise<SessionAbortOutcome | null>;
};

const NO_OP: AbortRunResult = { aborted: false };

async function loadAbortRunDeps(): Promise<AbortRunDeps | null> {
  // The SDK is optional at runtime and unavailable/unmockable under Vitest; tests
  // inject `deps` directly to exercise the real abort path.
  if (process.env.VITEST === "true") return null;
  try {
    const sdk = (await import("openclaw/plugin-sdk/agent-harness")) as Pick<
      AbortRunDeps,
      "resolveActiveEmbeddedRunSessionId" | "abortAgentHarnessRun"
    >;
    return { ...sdk, abortSessionRunTarget: abortSessionRunTargetFromCore };
  } catch {
    return null;
  }
}

/** `agent:<id>:<rest>` → `<id>`；裸 key 归默认 agent。 */
function resolveAgentIdFromSessionKey(sessionKey: string): string {
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return normalizeAgentId(match?.[1]);
}

/**
 * Abort the active run for a channel `sessionKey` — the CANONICAL OpenClaw stop.
 *
 * Primary path: core's own session-stop helper (`abortSessionRunTargetWithOutcome`, the
 * same chain as the `/stop` command). It marks the session's reply operation
 * `aborted_by_user` FIRST — so the dispatcher ends with a SILENT reply — then aborts the
 * embedded run. OpenClaw 2026.10.1 stopped propagating a plain `abortAgentHarnessRun`
 * into that operation marker, so the plain abort alone left the dispatch to emit its
 * no-visible-reply fallback ("⚠️ OpenClaw couldn't produce or deliver a reply…") to the
 * app after a user stop.
 *
 * Fallback path (older cores / bridge unavailable): resolve sessionKey → internal
 * sessionId (active runs are keyed by sessionId, not the channel runId), then fire a
 * PLAIN abort (`abortAgentHarnessRun` = `abortEmbeddedAgentRun` → `handle.abort()`),
 * which was sufficient through 2026.9.x.
 *
 * Deliberately NOT abort-and-drain with `forceClear`: `forceClear` force-fails the reply
 * operation (`operation.fail("run_failed", new Error("Embedded run force-cleared by …"))`)
 * and never fires the abort signal, so (a) the failed operation surfaces as a spurious
 * `dispatch_error`, and (b) without `externalAbort` the interrupted LLM call is classified
 * as a real failure → `"LLM request failed."`. Both show up as an error toast in the app.
 * `forceClear` is OpenClaw's stuck/cron-timeout recovery hammer, not a user-initiated stop.
 */
export async function abortRunForSessionKey(
  sessionKey: string,
  deps?: AbortRunDeps,
): Promise<AbortRunResult> {
  const key = sessionKey.trim();
  if (!key) return NO_OP;
  const resolved = deps ?? (await loadAbortRunDeps());
  if (!resolved) return NO_OP;
  try {
    // OpenClaw ≥2026.7.1 keys the active-run registry by the agent-qualified store key
    // (`agent:<id>:<sessionKey>`); older cores keyed the raw channel sessionKey. Try both —
    // a raw-key miss on a new core otherwise turns every app stop into a silent no-op.
    const candidates = [...new Set([key, toSessionStoreKey(key)])];
    const canonicalKey = candidates[candidates.length - 1];
    const abortSessionRunTarget = resolved.abortSessionRunTarget;
    if (abortSessionRunTarget) {
      const outcome = await abortSessionRunTarget({
        sessionKey: canonicalKey,
        agentId: resolveAgentIdFromSessionKey(canonicalKey),
      });
      if (outcome?.aborted) return { aborted: true };
    }
    for (const candidate of candidates) {
      const sessionId = resolved.resolveActiveEmbeddedRunSessionId(candidate);
      if (sessionId) {
        const aborted = resolved.abortAgentHarnessRun(sessionId);
        return { aborted };
      }
    }
    return NO_OP;
  } catch {
    // optional at runtime
    return NO_OP;
  }
}
