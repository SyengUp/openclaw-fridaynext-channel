/**
 * Resolve a cron job's delivery target for the notifications tracker.
 *
 * The `cron_changed` hook's job snapshot is built by the core's `toPluginCronJob()`, which does NOT
 * include the `delivery` block — so when the hook context can't hand us the raw job we read it from
 * the cron store (SQLite-backed) instead. Memoised for a short TTL: `cron_changed` fires twice per
 * run (started/finished) for every job on the gateway, and the delivery target of a job changes
 * only when the user edits it.
 *
 * Isolated from `cron-delivery-target.ts` on purpose: this file pulls in the plugin SDK / cron
 * store, the classification logic stays SDK-free and unit-testable.
 */

import { loadCronStore, resolveCronStorePath } from "openclaw/plugin-sdk/config-runtime";
import {
  readCronDeliveryTarget,
  UNKNOWN_CRON_DELIVERY,
  type CronDeliveryTarget,
} from "./cron-delivery-target.js";

const CACHE_TTL_MS = 60_000;

let cache: { atMs: number; byJobId: Map<string, CronDeliveryTarget> } | null = null;

/** Best-effort synchronous read from whatever the `cron_changed` hook handed us: the event's own
 *  job snapshot first, then the hook context's live cron service (`ctx.getCron().getJob(id)` — the
 *  same call the core itself makes). Returns "unknown" when neither is available. */
export function resolveCronDeliveryFromHook(
  jobId: string,
  event: unknown,
  ctx: unknown,
): CronDeliveryTarget {
  const fromEvent = readCronDeliveryTarget((event as { job?: unknown } | null)?.job);
  if (fromEvent.deliversToFridayNext !== null) return fromEvent;
  try {
    const getCron = (ctx as { getCron?: () => unknown } | null | undefined)?.getCron;
    const cron = typeof getCron === "function" ? getCron() : undefined;
    const getJob = (cron as { getJob?: (id: string) => unknown } | null | undefined)?.getJob;
    if (typeof getJob === "function") {
      return readCronDeliveryTarget(getJob.call(cron, jobId));
    }
  } catch {
    /* best-effort — a cron-service read must never break the hook */
  }
  return UNKNOWN_CRON_DELIVERY;
}

/** Asynchronous fallback: read the job out of the cron store. Never throws. */
export async function loadCronDeliveryTarget(jobId: string): Promise<CronDeliveryTarget> {
  const id = jobId.trim();
  if (!id) return UNKNOWN_CRON_DELIVERY;
  const nowMs = Date.now();
  if (!cache || nowMs - cache.atMs > CACHE_TTL_MS) {
    const byJobId = new Map<string, CronDeliveryTarget>();
    try {
      const store = await loadCronStore(resolveCronStorePath());
      for (const job of store.jobs) {
        if (job?.id) byJobId.set(job.id, readCronDeliveryTarget(job));
      }
    } catch {
      /* best-effort — a store read failure just leaves every job "unknown" */
    }
    cache = { atMs: nowMs, byJobId };
  }
  return cache.byJobId.get(id) ?? UNKNOWN_CRON_DELIVERY;
}

/** Test-only reset of the memoised store read. */
export function resetCronDeliveryLookupCacheForTest(): void {
  cache = null;
}
