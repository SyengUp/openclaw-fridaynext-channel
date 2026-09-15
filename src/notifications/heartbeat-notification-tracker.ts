/**
 * Short-lived records of STARTED heartbeat runs, fed by the gateway's
 * `before_agent_run` hook (gated on `ctx.trigger === "heartbeat"`). The channel's outbound
 * capture (`channel.ts` sendText / sendMedia) consults it to classify an offline background
 * push as a "heartbeat" rather than a generic "push" — but ONLY when the outbound carries
 * that exact run id. OpenClaw's current channel adapter drops the run id for direct heartbeat
 * delivery, so each run also contributes ONE consumable fallback claim. This closes that metadata
 * gap without recreating the old reusable global window that mislabeled many unrelated sends.
 *
 * Why anchor on `before_agent_run` and not the `onHeartbeatEvent` runtime signal: the
 * heartbeat event carries only TERMINAL statuses ("sent" / "ok-empty" / "failed" …) and is
 * emitted AROUND/AFTER the announce delivery, so at outbound-capture time it reflects the
 * PREVIOUS heartbeat (heartbeat intervals dwarf any sane correlation window). `before_agent_run`
 * fires when the run BEGINS — strictly before the delivery — so it is the ordering-safe
 * analog of the cron tracker's `cron_changed` "started" signal. It is a conversation hook,
 * gated by the friday-next plugin's `hooks.allowConversationAccess` (enabled on this gateway).
 *
 * The previous implementation exposed one reusable global 10-minute slot. Every unrelated
 * outbound in that interval was then labelled as heartbeat. Exact run keys plus a consumable
 * fallback preserve the signal while bounding metadata-free correlation to one send per run.
 */

// A heartbeat run announces once its agent turn completes; keep the window wide enough to
// cover a slow run anchored on its start, but tight enough not to bleed into a later,
// unrelated offline push. Heartbeat intervals are far longer than this.
const WINDOW_MS = 10 * 60_000;

const MAX_TRACKED = 64;
const runs = new Map<string, { atMs: number; agentId: string | null; fallbackClaimed: boolean }>();

function prune(nowMs: number): void {
  for (const [runId, run] of runs) {
    if (nowMs - run.atMs > WINDOW_MS) runs.delete(runId);
  }
  if (runs.size <= MAX_TRACKED) return;
  const oldestFirst = [...runs.entries()].sort((a, b) => a[1].atMs - b[1].atMs);
  for (const [runId] of oldestFirst.slice(0, runs.size - MAX_TRACKED)) runs.delete(runId);
}

/** Record a heartbeat run starting (from `before_agent_run` with `trigger === "heartbeat"`).
 *  `agentId` is the run's origin agent (extracted from `ctx.sessionKey`) so the outbound capture
 *  can attribute the push to it instead of the delivery-routing session's agent. */
export function noteHeartbeatActivity(
  runId: string | undefined,
  nowMs: number = Date.now(),
  agentId?: string | null,
): void {
  const id = (runId ?? "").trim();
  if (!id) return;
  runs.set(id, { atMs: nowMs, agentId: agentId?.trim() || null, fallbackClaimed: false });
  prune(nowMs);
}

/** Resolve heartbeat identity only for the exact outbound run id. */
export function recentHeartbeatForRun(
  runId: string | undefined,
  nowMs: number = Date.now(),
): { agentId: string | null } | null {
  const id = (runId ?? "").trim();
  if (!id) return null;
  prune(nowMs);
  const run = runs.get(id);
  return run ? { agentId: run.agentId } : null;
}

/**
 * Claim the one metadata-free outbound that may belong to a heartbeat run. Passing `runId`
 * consumes that exact run's fallback (used when the adapter did retain the id); otherwise the
 * newest unclaimed run wins. A run can never claim a second unrelated outbound.
 */
export function claimRecentHeartbeatFallback(
  nowMs: number = Date.now(),
  runId?: string,
): { agentId: string | null } | null {
  prune(nowMs);
  const exactId = (runId ?? "").trim();
  const candidate = exactId
    ? ([exactId, runs.get(exactId)] as const)
    : [...runs.entries()]
        .filter(([, run]) => !run.fallbackClaimed)
        .sort((a, b) => b[1].atMs - a[1].atMs)[0];
  if (!candidate) return null;
  const [, run] = candidate;
  if (!run || run.fallbackClaimed) return null;
  run.fallbackClaimed = true;
  return { agentId: run.agentId };
}

/** Test-only reset. */
export function resetHeartbeatNotificationTrackerForTest(): void {
  runs.clear();
}
