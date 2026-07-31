/**
 * Short-lived record of the scheduled tasks (cron jobs) that are active right now, fed by the
 * gateway's `cron_changed` hook. The channel's outbound capture (`channel.ts` sendText / sendMedia
 * and `channel-actions.ts` handleSend) consults it to attribute an offline background push to its
 * originating cron job BY NAME.
 *
 * Why a correlation rather than reading the jobId off the outbound context:
 * a real cron `announce` delivery reaches the channel outbound with NO cron origin — the core's
 * `ChannelOutboundContext` carries cfg/to/accountId and nothing about the run, so the session key
 * resolves to the friday delivery/history key, never `agent:…:cron:<jobId>` (see the comment in
 * channel.ts sendText). The only first-party carrier of the jobId + human name is the
 * `cron_changed` hook, which fires around the same moment the delivery happens.
 *
 * Why a MAP of active runs and not a single "most recent" slot (2026-07-31 bug): jobs run
 * concurrently. "每日科技" started at 07:30:00.022 and pushed at 07:32:48 — but `miloco-home-patrol`
 * started 13ms later and overwrote the single slot, so the push was labelled with the wrong job
 * (and that job never pushes to the app at all). Keeping every live run and RANKING them lets us
 * (a) prefer the job that actually announces to friday-next, and (b) refuse to guess — an
 * ambiguous window yields no name at all (the push still records as `kind: "cron"`, the app just
 * shows the generic label) instead of confidently naming the wrong task.
 */

import {
  UNKNOWN_CRON_DELIVERY,
  type CronDeliveryTarget,
} from "./cron-delivery-target.js";

type CronRunRecord = {
  jobId: string;
  name: string;
  agentId: string | null;
  delivery: CronDeliveryTarget;
  /** Started and not yet finished — ranked above already-finished runs. */
  running: boolean;
  /** Last `started`/`finished` activity for this job (the window anchor). */
  lastAtMs: number;
};

// A cron run's `started` fires when the agent turn begins and `finished` when it completes and
// delivers; the announce delivery lands between the two (07:32:48 for a 07:30:00→07:34:17 run) or
// right after. Keep the window wide enough to cover a slow agent run anchored on `started`,
// refreshed on `finished`.
const WINDOW_MS = 15 * 60_000;
// Defensive cap: the map only ever holds jobs seen within the window, but a gateway that churns
// through many one-shot jobs shouldn't grow it without bound.
const MAX_TRACKED = 64;

const runs = new Map<string, CronRunRecord>();

function prune(nowMs: number): void {
  for (const [jobId, run] of runs) {
    if (nowMs - run.lastAtMs > WINDOW_MS) runs.delete(jobId);
  }
  if (runs.size <= MAX_TRACKED) return;
  const oldestFirst = [...runs.entries()].sort((a, b) => a[1].lastAtMs - b[1].lastAtMs);
  for (const [jobId] of oldestFirst.slice(0, runs.size - MAX_TRACKED)) runs.delete(jobId);
}

/** Record cron activity from a `cron_changed` started/finished event.
 *
 *  - `agentId` (when the event carries it) is the job's owning agent, so the outbound capture can
 *    attribute the push to it rather than to the delivery-routing session's agent (which is usually
 *    the app's current one).
 *  - `options.delivery` says whether this job announces to friday-next at all; omit it (or pass the
 *    unknown value) when it can't be resolved — unknown jobs stay eligible, they just lose to a
 *    known friday-next job.
 */
export function noteCronActivity(
  jobId: string | undefined,
  name: string | undefined | null,
  agentId?: string | null,
  options?: {
    action?: "started" | "finished";
    delivery?: CronDeliveryTarget;
    nowMs?: number;
  },
): void {
  const id = (jobId ?? "").trim();
  if (!id) return;
  const nowMs = options?.nowMs ?? Date.now();
  const previous = runs.get(id);
  runs.set(id, {
    jobId: id,
    name: (name ?? "").trim(),
    agentId: agentId?.trim() || previous?.agentId || null,
    // A `finished` event carries the same job snapshot as `started`; keep whatever we already
    // resolved when this call can't say (e.g. the async store lookup patched it in meanwhile).
    delivery: options?.delivery ?? previous?.delivery ?? UNKNOWN_CRON_DELIVERY,
    running: (options?.action ?? "started") !== "finished",
    lastAtMs: nowMs,
  });
  prune(nowMs);
}

/** Patch a tracked job's delivery target once it has been resolved asynchronously (the hook's job
 *  snapshot doesn't carry `delivery`, so index.ts falls back to a cron-store read). No-op for a job
 *  that is no longer tracked. */
export function updateCronDeliveryTarget(
  jobId: string | undefined,
  delivery: CronDeliveryTarget,
): void {
  const id = (jobId ?? "").trim();
  if (!id) return;
  const run = runs.get(id);
  if (!run) return;
  run.delivery = delivery;
}

/** Live runs that could plausibly have produced a push to `deviceId`, best candidates first. */
function candidates(nowMs: number, deviceId?: string): CronRunRecord[] {
  const device = deviceId?.trim().toUpperCase();
  const live = [...runs.values()].filter(
    (run) =>
      nowMs - run.lastAtMs <= WINDOW_MS &&
      // A job that announces to another channel can never be the source of a friday-next push.
      run.delivery.deliversToFridayNext !== false &&
      // A job pinned to a different device likewise can't be this device's push.
      (!device || !run.delivery.to || run.delivery.to === device),
  );
  // A job KNOWN to announce to friday-next always beats one we merely couldn't classify — this is
  // what pulls "每日科技" ahead of a same-minute patrol job with no friday delivery.
  const known = live.filter((run) => run.delivery.deliversToFridayNext === true);
  return known.length > 0 ? known : live;
}

/** The single job we can confidently credit for a push, or null when the window is empty OR
 *  ambiguous (several equally plausible jobs — better a generic "定时任务" than the wrong name). */
function winner(nowMs: number, deviceId?: string): CronRunRecord | null {
  const live = candidates(nowMs, deviceId);
  if (live.length === 0) return null;
  const running = live.filter((run) => run.running);
  const pool = running.length > 0 ? running : live;
  return pool.length === 1 ? (pool[0] ?? null) : null;
}

/** The attributable cron's { jobId, name } — null when no cron is live or the window is ambiguous.
 *  The jobId is the durable key: the display name is resolved LIVE from the cron store at read time
 *  so a renamed job updates every past notification. */
export function recentCron(
  nowMs: number = Date.now(),
  deviceId?: string,
): { jobId: string; name: string } | null {
  const run = winner(nowMs, deviceId);
  return run ? { jobId: run.jobId, name: run.name } : null;
}

/** Convenience: the attributable cron's display name, if any. */
export function recentCronJobName(nowMs: number = Date.now(), deviceId?: string): string | null {
  return recentCron(nowMs, deviceId)?.name || null;
}

/** The most recent activity timestamp among plausible cron candidates, else null. This — NOT
 *  `recentCron` — decides whether a push is a cron push at all: an ambiguous window still means a
 *  cron fired, we just can't name it. Also lets the classifier compare cron vs heartbeat recency so
 *  the fresher trigger wins. */
export function recentCronAtMs(nowMs: number = Date.now(), deviceId?: string): number | null {
  const live = candidates(nowMs, deviceId);
  if (live.length === 0) return null;
  return live.reduce((max, run) => (run.lastAtMs > max ? run.lastAtMs : max), 0);
}

/** The owning agent id of the attributable cron, else null. */
export function recentCronAgentId(nowMs: number = Date.now(), deviceId?: string): string | null {
  return winner(nowMs, deviceId)?.agentId ?? null;
}

/** Test-only reset. */
export function resetCronNotificationTrackerForTest(): void {
  runs.clear();
}
