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
 * `deviceId` narrows the cron correlation to jobs that can actually push to THIS device (a job
 * pinned to another device is excluded); pass it whenever the caller knows the target.
 *
 * Note the split between `kind` and `cron`: an ambiguous window (several plausible jobs) still
 * yields `kind: "cron"` — a scheduled task DID fire — but no `cron` identity, so the inbox shows a
 * generic label instead of confidently naming the wrong task.
 *
 * Callers use this to durably capture cron/heartbeat pushes REGARDLESS of connection state, so a
 * lost live delivery (SSE flap, backgrounded app) can never silently drop a background push — the
 * notifications inbox is their durable record. Returns `kind: null` for a normal reply.
 */

import { recentCron, recentCronAtMs, recentCronAgentId } from "./cron-notification-tracker.js";
import { recentHeartbeatAtMs, recentHeartbeatAgentId } from "./heartbeat-notification-tracker.js";

export function resolveBackgroundPushKind(deviceId?: string): {
  kind: "cron" | "heartbeat" | null;
  cron: { jobId: string; name: string } | null;
  // The originating agent's id when the winning trigger carries it (else null). Lets the caller
  // attribute the push to the agent that actually ran it, not the delivery-routing session's agent.
  agentId: string | null;
} {
  const nowMs = Date.now();
  const cronAt = recentCronAtMs(nowMs, deviceId);
  const hbAt = recentHeartbeatAtMs(nowMs);
  if (cronAt != null && (hbAt == null || cronAt >= hbAt)) {
    return {
      kind: "cron",
      cron: recentCron(nowMs, deviceId),
      agentId: recentCronAgentId(nowMs, deviceId),
    };
  }
  if (hbAt != null) return { kind: "heartbeat", cron: null, agentId: recentHeartbeatAgentId(nowMs) };
  return { kind: null, cron: null, agentId: null };
}
