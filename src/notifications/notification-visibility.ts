import type { FridayNotification } from "./notifications-store.js";
import { cronJobIdFromSessionKey } from "./cron-session-key.js";

export type CronNotificationMetadata = {
  name?: string;
  isSystemHeartbeat: boolean;
};

// Compatibility cleanup for rows written before heartbeat provenance became reliable. These are
// exact OpenClaw-owned envelopes, not a broad text/keyword heuristic: a normal message merely
// discussing "heartbeat" must remain visible.
const LEGACY_OPENCLAW_HEARTBEAT_PREFIXES = [
  "First heartbeat alert: your bot runs periodic background checks and messages you only when something needs attention.",
  "⚠️ Heartbeat check failed before it could produce an update. The main chat session remains available.",
] as const;

/** Decide whether a legacy durable row is infrastructure noise that Control UI would not expose. */
export function shouldHideNotification(
  notification: Pick<FridayNotification, "kind" | "sourceSessionKey" | "jobId"> &
    Partial<Pick<FridayNotification, "text">>,
  cronMetadata: ReadonlyMap<string, CronNotificationMetadata>,
): boolean {
  if (notification.kind.trim().toLowerCase() === "heartbeat") return true;
  const text = notification.text?.trimStart() ?? "";
  if (LEGACY_OPENCLAW_HEARTBEAT_PREFIXES.some((prefix) => text.startsWith(prefix))) return true;
  const jobId = cronJobIdFromSessionKey(notification.sourceSessionKey) ?? notification.jobId ?? "";
  return cronMetadata.get(jobId)?.isSystemHeartbeat === true;
}
