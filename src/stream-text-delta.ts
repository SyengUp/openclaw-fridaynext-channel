/**
 * Shared streaming text delta for reasoning / final assistant text.
 * OpenClaw often sends cumulative strings; SSE prefers short tails + optional patch index.
 */

/** UTF-16 code unit index of first mismatch (longest common prefix length). */
export function longestCommonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

/**
 * Prefer strict suffix (`next.startsWith(prev)`); else LCP tail for small rewrites.
 * `patchPrefixChars` (UTF-16 index): merge as `buffer = buffer.slice(0, n) + delta`.
 */
export function computeStreamDelta(
  prev: string,
  next: string,
): { delta: string; patchPrefixChars?: number } {
  if (!prev) return { delta: next };
  if (next.startsWith(prev)) return { delta: next.slice(prev.length) };
  const lcp = longestCommonPrefixLength(prev, next);
  const delta = next.slice(lcp);
  if (lcp < prev.length) return { delta, patchPrefixChars: lcp };
  return { delta };
}

const lastFinalFullTextByRunId = new Map<string, string>();

/** Next cumulative `fullText` → SSE delta for this run; updates per-run snapshot. */
export function takeFinalSseDelta(
  runId: string,
  nextFullText: string,
): { delta: string; patchPrefixChars?: number } {
  const prev = lastFinalFullTextByRunId.get(runId) ?? "";
  const out = computeStreamDelta(prev, nextFullText);
  lastFinalFullTextByRunId.set(runId, nextFullText);
  return out;
}

export function resetFinalStream(runId: string): void {
  lastFinalFullTextByRunId.delete(runId);
}

/** Last cumulative final text seen for this run (for error-path history flush). */
export function peekFinalFullText(runId: string): string | undefined {
  return lastFinalFullTextByRunId.get(runId);
}
