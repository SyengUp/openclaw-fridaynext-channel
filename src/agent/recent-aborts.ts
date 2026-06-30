/**
 * Tracks recent user-initiated aborts per channel sessionKey.
 *
 * When the user stops a run, OpenClaw's embedded runner / Codex backend can still surface an
 * error as a consequence of the interruption — the aborted run's own failover ("LLM request
 * failed.") or a generic failure on the very next turn ("Something went wrong …"). Those are
 * abort-noise, not real failures the user should see as an error toast. The channel records the
 * abort here so the deliver/error forwarders can drop `isError` payloads that land within a short
 * window of a stop the user explicitly requested.
 */
const recentAbortAtMs = new Map<string, number>();

/** How long after a user stop to treat surfaced errors as abort-noise. */
export const RECENT_ABORT_SUPPRESSION_MS = 20_000;

export function markUserAbort(sessionKey: string, nowMs: number = Date.now()): void {
  const key = sessionKey.trim();
  if (key) recentAbortAtMs.set(key, nowMs);
}

export function wasRecentlyUserAborted(sessionKey: string, nowMs: number = Date.now()): boolean {
  const key = sessionKey.trim();
  if (!key) return false;
  const at = recentAbortAtMs.get(key);
  if (at === undefined) return false;
  if (nowMs - at > RECENT_ABORT_SUPPRESSION_MS) {
    recentAbortAtMs.delete(key);
    return false;
  }
  return true;
}

/** Test/maintenance hook. */
export function clearRecentAborts(): void {
  recentAbortAtMs.clear();
}
