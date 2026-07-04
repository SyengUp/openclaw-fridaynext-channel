/**
 * Classify an agent-initiated outbound send as a background push (cron / heartbeat).
 *
 * A real cron/heartbeat delivery reaches the channel outbound with NO reliable origin marker:
 * the announce path resolves the session key to a device/history key (never `:cron:`/`:heartbeat`),
 * and the `message`-tool path (handleSend) runs under a session key that likewise may not carry
 * the marker. So we correlate against the most-recent background trigger within its window —
 * `recentCron` (fed by `cron_changed`) and `recentHeartbeat` (fed by `before_agent_run`).
 * Cron wins ties because it carries a durable job identity (jobId/name).
 *
 * Callers use this to durably capture cron/heartbeat pushes REGARDLESS of connection state, so a
 * lost live delivery (SSE flap, backgrounded app) can never silently drop a background push — the
 * notifications inbox is their durable record. Returns `kind: null` for a normal reply.
 */

import { recentCron, recentCronAtMs } from "./cron-notification-tracker.js";
import { recentHeartbeatAtMs } from "./heartbeat-notification-tracker.js";

export function resolveBackgroundPushKind(): {
  kind: "cron" | "heartbeat" | null;
  cron: { jobId: string; name: string } | null;
} {
  const cron = recentCron();
  const cronAt = recentCronAtMs();
  const hbAt = recentHeartbeatAtMs();
  if (cron && (hbAt == null || (cronAt ?? 0) >= hbAt)) return { kind: "cron", cron };
  if (hbAt != null) return { kind: "heartbeat", cron: null };
  return { kind: null, cron: null };
}
