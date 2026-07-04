/**
 * Pure helper (no SDK / SQLite imports, so it's unit-testable in isolation) for
 * pulling the cron jobId out of a notification's source session key.
 */

/** Extract the cron jobId from a source session key like
 *  `agent:<id>:cron:<jobId>:run:<runId>` or `agent:<id>:cron:<jobId>` (UUIDs have no
 *  colons, so the segment after `:cron:` is the whole jobId). Null for non-cron keys. */
export function cronJobIdFromSessionKey(sessionKey: string | undefined): string | null {
  const m = (sessionKey ?? "").match(/:cron:([^:]+)/i);
  return m?.[1]?.trim() || null;
}
