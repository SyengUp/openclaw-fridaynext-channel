/**
 * Where a scheduled task (cron job) actually delivers — the discriminator that keeps a
 * friday-next background push from being attributed to an unrelated job that merely ran at the
 * same moment.
 *
 * Why this is needed: the core hands the channel outbound NO origin identity (see
 * cron-notification-tracker), so the notifications inbox has to CORRELATE a push with a recently
 * active cron. On 2026-07-31 "每日科技"'s 07:30 push was labelled "miloco-home-patrol" purely
 * because that job started 13ms later and overwrote the correlation slot — yet it never pushes to
 * the app at all. A job that announces elsewhere can never be the source of a friday-next push, so
 * it must not compete.
 *
 * Pure + SDK-free on purpose (the store lookup lives in `cron-delivery-lookup.ts`) so the
 * classification stays unit-testable without the SQLite-backed cron store.
 */

export const FRIDAY_NEXT_CHANNEL_ID = "friday-next";

/** Channel values that name no concrete channel (the core fills `channel: "last"` in by default),
 *  so they can neither confirm nor rule out friday-next. */
const PLACEHOLDER_CHANNELS = new Set(["last", "auto", "origin", "default", "none"]);

export type CronDeliveryTarget = {
  /** `true` = announces to friday-next · `false` = announces to another channel · `null` = unknown.
   *  Unknown MUST remain ELIGIBLE for attribution: a cron that pushes via the `message` tool has no
   *  delivery block at all, yet still reaches the app. Unknown simply LOSES to a known friday-next
   *  job when both are live (see cron-notification-tracker's candidate ranking). */
  deliversToFridayNext: boolean | null;
  /** The pinned target device id when the job names one (uppercased), else null. */
  to: string | null;
};

export const UNKNOWN_CRON_DELIVERY: CronDeliveryTarget = {
  deliversToFridayNext: null,
  to: null,
};

/** Classify a cron job record (from the `cron_changed` hook's job snapshot or the cron store).
 *  Anything we can't read confidently degrades to "unknown" — never to a hard exclusion. */
export function readCronDeliveryTarget(job: unknown): CronDeliveryTarget {
  if (!job || typeof job !== "object") return UNKNOWN_CRON_DELIVERY;
  const delivery = (job as { delivery?: unknown }).delivery;
  // No delivery block = the job announces nothing by itself, but its agent turn can still push via
  // the `message` tool — unknown, not excluded.
  if (!delivery || typeof delivery !== "object") return UNKNOWN_CRON_DELIVERY;
  const rawMode = (delivery as { mode?: unknown }).mode;
  const mode = typeof rawMode === "string" ? rawMode.trim().toLowerCase() : "";
  // `mode: "none"` (what `cron add --no-deliver` writes) announces nothing — same story as a job
  // with no delivery block at all: it can still push from inside its turn, so it stays eligible.
  if (mode === "none") return UNKNOWN_CRON_DELIVERY;
  const rawChannel = (delivery as { channel?: unknown }).channel;
  const channel = typeof rawChannel === "string" ? rawChannel.trim().toLowerCase() : "";
  // An announce with no concrete channel resolves to the job's origin/last channel, which we
  // cannot resolve here — unknown, never excluded.
  if (!channel || PLACEHOLDER_CHANNELS.has(channel)) return UNKNOWN_CRON_DELIVERY;
  // Only an explicitly NAMED other channel rules the job out.
  if (channel !== FRIDAY_NEXT_CHANNEL_ID) return { deliversToFridayNext: false, to: null };
  const rawTo = (delivery as { to?: unknown }).to;
  const to = typeof rawTo === "string" && rawTo.trim() ? rawTo.trim().toUpperCase() : null;
  return { deliversToFridayNext: true, to };
}
