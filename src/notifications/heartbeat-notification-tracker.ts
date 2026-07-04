/**
 * Short-lived record of the most recently STARTED heartbeat run, fed by the gateway's
 * `before_agent_run` hook (gated on `ctx.trigger === "heartbeat"`). The channel's outbound
 * capture (`channel.ts` sendText / sendMedia) consults it to classify an offline background
 * push as a "heartbeat" rather than a generic "push".
 *
 * Why anchor on `before_agent_run` and not the `onHeartbeatEvent` runtime signal: the
 * heartbeat event carries only TERMINAL statuses ("sent" / "ok-empty" / "failed" …) and is
 * emitted AROUND/AFTER the announce delivery, so at outbound-capture time it reflects the
 * PREVIOUS heartbeat (heartbeat intervals dwarf any sane correlation window). `before_agent_run`
 * fires when the run BEGINS — strictly before the delivery — so it is the ordering-safe
 * analog of the cron tracker's `cron_changed` "started" signal. It is a conversation hook,
 * gated by the friday-next plugin's `hooks.allowConversationAccess` (enabled on this gateway).
 *
 * Unlike cron, a heartbeat has no durable per-job identity — it is a recurring self-check —
 * so we track only the run's start timestamp for time-window correlation.
 */

// A heartbeat run announces once its agent turn completes; keep the window wide enough to
// cover a slow run anchored on its start, but tight enough not to bleed into a later,
// unrelated offline push. Heartbeat intervals are far longer than this.
const WINDOW_MS = 10 * 60_000;

let atMs: number | null = null;

/** Record a heartbeat run starting (from `before_agent_run` with `trigger === "heartbeat"`). */
export function noteHeartbeatActivity(nowMs: number = Date.now()): void {
  atMs = nowMs;
}

/** The start timestamp of a heartbeat run that fired within the window, else null. Returning
 *  the timestamp (not a bool) lets the caller compare recency against the cron tracker so the
 *  more-recent background trigger wins when both are live. */
export function recentHeartbeatAtMs(nowMs: number = Date.now()): number | null {
  if (atMs == null) return null;
  if (nowMs - atMs > WINDOW_MS) return null;
  return atMs;
}

/** Test-only reset. */
export function resetHeartbeatNotificationTrackerForTest(): void {
  atMs = null;
}
