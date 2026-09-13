/**
 * Classify an agent-initiated outbound send as cron or an exact heartbeat run.
 *
 * A real cron/heartbeat delivery reaches the channel outbound with NO reliable origin marker:
 * the announce path resolves the session key to a device/history key (never `:cron:`/`:heartbeat`),
 * and the `message`-tool path (handleSend) runs under a session key that likewise may not carry
 * the marker. So we correlate against the most-recent background trigger within its window —
 * `recentCron` (fed by `cron_changed`) and heartbeat runs (fed by `before_agent_run`). Exact run-id
 * matching is preferred. Because OpenClaw currently drops the run id at direct heartbeat channel
 * delivery, one metadata-free outbound may consume a fallback claim; unlike the old reusable
 * global window, that fallback cannot relabel a stream of unrelated progress messages.
 *
 * `deviceId` narrows the cron correlation to jobs that can actually push to THIS device (a job
 * pinned to another device is excluded); pass it whenever the caller knows the target.
 *
 * Note the split between `kind` and `cron`: an ambiguous window (several plausible jobs) still
 * yields `kind: "cron"` — a scheduled task DID fire — but no `cron` identity, so the inbox shows a
 * generic label instead of confidently naming the wrong task.
 *
 * Callers use cron results for durable inbox capture regardless of connection state. Heartbeat
 * results are passed to the store's explicit suppression gate. Returns `kind: null` for a normal
 * reply.
 */

import { recentCron, recentCronAtMs, recentCronAgentId } from "./cron-notification-tracker.js";
import {
  claimRecentHeartbeatFallback,
  recentHeartbeatForRun,
} from "./heartbeat-notification-tracker.js";

export function resolveBackgroundPushKind(
  deviceId?: string,
  runId?: string,
): {
  kind: "cron" | "heartbeat" | null;
  cron: { jobId: string; name: string } | null;
  // The originating agent's id when the winning trigger carries it (else null). Lets the caller
  // attribute the push to the agent that actually ran it, not the delivery-routing session's agent.
  agentId: string | null;
} {
  const nowMs = Date.now();
  const heartbeat = recentHeartbeatForRun(runId, nowMs);
  if (heartbeat) {
    claimRecentHeartbeatFallback(nowMs, runId);
    return { kind: "heartbeat", cron: null, agentId: heartbeat.agentId };
  }
  const cronAt = recentCronAtMs(nowMs, deviceId);
  if (cronAt != null) {
    return {
      kind: "cron",
      cron: recentCron(nowMs, deviceId),
      agentId: recentCronAgentId(nowMs, deviceId),
    };
  }
  const heartbeatFallback = claimRecentHeartbeatFallback(nowMs);
  if (heartbeatFallback) {
    return { kind: "heartbeat", cron: null, agentId: heartbeatFallback.agentId };
  }
  return { kind: null, cron: null, agentId: null };
}
