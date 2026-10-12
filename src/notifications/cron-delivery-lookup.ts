/**
 * Resolve a cron job's delivery target for the notifications tracker.
 *
 * The `cron_changed` hook's job snapshot is built by the core's `toPluginCronJob()`, which does NOT
 * include the `delivery` block — so the delivery target is read from the hook context's live cron
 * service (`ctx.getCron().getJob(id)` — the same call the core itself makes). No store fallback:
 * 2026.10.1 removed the `config-runtime` SDK subpath and `cron-store-runtime` is host-private;
 * when the hook can't hand us the raw job the target stays "unknown" (fail closed).
 *
 * Isolated from `cron-delivery-target.ts` on purpose: this file touches the host hook context,
 * the classification logic stays SDK-free and unit-testable.
 */

import {
  readCronDeliveryTarget,
  UNKNOWN_CRON_DELIVERY,
  type CronDeliveryTarget,
} from "./cron-delivery-target.js";

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
