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
// The originating agent's id (from the heartbeat run's `agent:<id>:…:heartbeat` session key).
// A heartbeat's outbound delivery reaches the channel with a device/history session key that
// resolves to the app's CURRENT session agent (usually `main`), NOT the agent that actually ran
// the heartbeat — so without this the notifications inbox mis-attributes every non-main agent's
// heartbeat to `main`. Captured here at run start (the only carrier of the true origin identity).
let originAgentId: string | null = null;

/** Record a heartbeat run starting (from `before_agent_run` with `trigger === "heartbeat"`).
 *  `agentId` is the run's origin agent (extracted from `ctx.sessionKey`) so the outbound capture
 *  can attribute the push to it instead of the delivery-routing session's agent. */
export function noteHeartbeatActivity(
  nowMs: number = Date.now(),
  agentId?: string | null,
): void {
  atMs = nowMs;
  originAgentId = agentId?.trim() || null;
}

/** The start timestamp of a heartbeat run that fired within the window, else null. Returning
 *  the timestamp (not a bool) lets the caller compare recency against the cron tracker so the
 *  more-recent background trigger wins when both are live. */
export function recentHeartbeatAtMs(nowMs: number = Date.now()): number | null {
  if (atMs == null) return null;
  if (nowMs - atMs > WINDOW_MS) return null;
  return atMs;
}

/** The origin agent id of a heartbeat run that fired within the window, else null. */
export function recentHeartbeatAgentId(nowMs: number = Date.now()): string | null {
  if (atMs == null || nowMs - atMs > WINDOW_MS) return null;
  return originAgentId;
}

/** Test-only reset. */
export function resetHeartbeatNotificationTrackerForTest(): void {
  atMs = null;
  originAgentId = null;
}
