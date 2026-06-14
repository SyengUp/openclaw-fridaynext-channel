export type AbortRunResult = { aborted: boolean; drained: boolean };

/**
 * Abort the active run for a channel `sessionKey`.
 *
 * A session has at most one active run at a time, and the SDK keys active runs by
 * their internal `sessionId` (not the channel runId). So resolve sessionKey → sessionId
 * first, then abort-and-drain so the caller learns whether the run actually settled.
 */
export async function abortRunForSessionKey(sessionKey: string): Promise<AbortRunResult> {
  if (process.env.VITEST === "true") return { aborted: false, drained: false };
  const key = sessionKey.trim();
  if (!key) return { aborted: false, drained: false };
  try {
    const { resolveActiveEmbeddedRunSessionId, abortAndDrainAgentHarnessRun } = await import(
      "openclaw/plugin-sdk/agent-harness"
    );
    const sessionId = resolveActiveEmbeddedRunSessionId(key);
    if (!sessionId) return { aborted: false, drained: false };
    const result = await abortAndDrainAgentHarnessRun({ sessionId, sessionKey: key });
    return { aborted: result.aborted, drained: result.drained };
  } catch {
    // optional at runtime
    return { aborted: false, drained: false };
  }
}
