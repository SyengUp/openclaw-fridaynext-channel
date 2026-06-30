export type AbortRunResult = { aborted: boolean };

export type AbortRunDeps = {
  resolveActiveEmbeddedRunSessionId: (sessionKey: string) => string | undefined;
  abortAgentHarnessRun: (sessionId: string) => boolean;
};

const NO_OP: AbortRunResult = { aborted: false };

async function loadAbortRunDeps(): Promise<AbortRunDeps | null> {
  // The SDK is optional at runtime and unavailable/unmockable under Vitest; tests
  // inject `deps` directly to exercise the real abort path.
  if (process.env.VITEST === "true") return null;
  try {
    return await import("openclaw/plugin-sdk/agent-harness");
  } catch {
    return null;
  }
}

/**
 * Abort the active run for a channel `sessionKey` — the CANONICAL OpenClaw stop.
 *
 * Mirrors how ControlUI (`chat.abort` → `abortChatRunById`) and the voice/`/compact`/
 * steer paths stop a run: resolve sessionKey → internal sessionId (active runs are keyed
 * by sessionId, not the channel runId), then fire a PLAIN abort (`abortAgentHarnessRun`
 * = `abortEmbeddedAgentRun` → `handle.abort()`). That sets the run's `externalAbort` flag
 * so it unwinds to a clean `"aborted_by_user"` terminal — a SILENT reply plus a
 * `status:"cancelled"` lifecycle — with NO error event.
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
    const sessionId = resolved.resolveActiveEmbeddedRunSessionId(key);
    if (!sessionId) return NO_OP;
    const aborted = resolved.abortAgentHarnessRun(sessionId);
    return { aborted };
  } catch {
    // optional at runtime
    return NO_OP;
  }
}
