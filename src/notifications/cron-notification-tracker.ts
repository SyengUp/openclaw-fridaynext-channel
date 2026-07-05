/**
 * Short-lived record of the most recently active scheduled task (cron job), fed by the
 * gateway's `cron_changed` hook. The channel's outbound capture (`channel.ts` sendText /
 * sendMedia) consults it to attribute an offline background push to its originating cron
 * job BY NAME.
 *
 * Why a time-window correlation rather than reading the jobId off the outbound context:
 * a real cron `announce` delivery reaches the channel outbound with NO cron origin — the
 * core resolves the session key to the friday delivery/history key, never
 * `agent:…:cron:<jobId>` (see the comment in channel.ts sendText). The only first-party
 * carrier of the jobId + human name is the `cron_changed` hook, which fires around the
 * same moment the delivery happens. We anchor on it and tag pushes within the window.
 */

type ActiveCron = { jobId: string; name: string; atMs: number; agentId: string | null };

// A cron run's `started` fires when the agent turn begins and `finished` when it completes
// and delivers; the announce delivery lands right around `finished`. Keep the window wide
// enough to cover a slow agent run anchored on `started`, refreshed on `finished`.
const WINDOW_MS = 15 * 60_000;

let active: ActiveCron | null = null;

/** Record cron activity from a `cron_changed` started/finished event. `agentId` (when the event
 *  carries it) is the job's owning agent, so the outbound capture can attribute the push to it
 *  rather than to the delivery-routing session's agent (which is usually the app's current one). */
export function noteCronActivity(
  jobId: string | undefined,
  name: string | undefined | null,
  agentId?: string | null,
): void {
  const id = (jobId ?? "").trim();
  if (!id) return;
  active = { jobId: id, name: (name ?? "").trim(), atMs: Date.now(), agentId: agentId?.trim() || null };
}

/** The active cron's { jobId, name } if one fired within the window, else null. The
 *  jobId is the durable key — the display name is resolved LIVE from the cron store at
 *  read time so a renamed job updates every past notification. */
export function recentCron(nowMs: number = Date.now()): { jobId: string; name: string } | null {
  if (!active) return null;
  if (nowMs - active.atMs > WINDOW_MS) return null;
  return { jobId: active.jobId, name: active.name };
}

/** Convenience: the active cron's display name if one fired within the window. */
export function recentCronJobName(nowMs: number = Date.now()): string | null {
  return recentCron(nowMs)?.name || null;
}

/** The active cron's activity timestamp if one fired within the window, else null. Lets the
 *  outbound classifier compare cron vs heartbeat recency so the fresher trigger wins. */
export function recentCronAtMs(nowMs: number = Date.now()): number | null {
  if (!active) return null;
  if (nowMs - active.atMs > WINDOW_MS) return null;
  return active.atMs;
}

/** The owning agent id of a cron job that fired within the window, else null. */
export function recentCronAgentId(nowMs: number = Date.now()): string | null {
  if (!active || nowMs - active.atMs > WINDOW_MS) return null;
  return active.agentId;
}

/** Test-only reset. */
export function resetCronNotificationTrackerForTest(): void {
  active = null;
}
