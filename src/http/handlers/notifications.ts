/**
 * GET /friday-next/notifications?deviceId=&afterSeq=
 *
 * Returns the durable log of user-visible scheduled/background pushes for a device.
 * Raw heartbeat output is not an inbox item (matching Control UI). User-visible pushes are
 * captured at the outbound boundary regardless of connection, so anything sent while the device
 * was offline appears on reconnect.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken } from "../middleware/auth.js";
import { fridayNotificationsStore } from "../../notifications/notifications-store.js";
import { resolveConfiguredAgents } from "./agents-list.js";
import { loadCronStore, resolveCronStorePath } from "openclaw/plugin-sdk/config-runtime";
import { cronJobIdFromSessionKey } from "../../notifications/cron-session-key.js";
import { isSystemHeartbeatCronJob } from "../../notifications/cron-delivery-target.js";
import {
  shouldHideNotification,
  type CronNotificationMetadata,
} from "../../notifications/notification-visibility.js";

/** Best-effort jobId → job-name map from the cron store (empty on any failure —
 *  the app falls back to a generic "定时任务" label when a name is absent). */
async function loadCronNotificationMetadata(): Promise<Map<string, CronNotificationMetadata>> {
  const metadata = new Map<string, CronNotificationMetadata>();
  try {
    const store = await loadCronStore(resolveCronStorePath());
    for (const job of store.jobs) {
      const name = job.name?.trim();
      if (job.id) {
        metadata.set(job.id, {
          ...(name ? { name } : {}),
          isSystemHeartbeat: isSystemHeartbeatCronJob(job),
        });
      }
    }
  } catch {
    /* best-effort — a cron-store read failure must not break the inbox */
  }
  return metadata;
}

export async function handleNotifications(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return true;
  }

  const token = extractBearerToken(req);
  if (!token) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Unauthorized: bearer token mismatch" }));
    return true;
  }

  const url = new URL(req.url ?? "", "http://localhost");
  const deviceId = (url.searchParams.get("deviceId") ?? "").trim();
  if (!deviceId) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing deviceId" }));
    return true;
  }
  const afterSeqRaw = Number(url.searchParams.get("afterSeq") ?? "0");
  const afterSeq = Number.isFinite(afterSeqRaw) ? afterSeqRaw : 0;

  const items = fridayNotificationsStore.readAfter(deviceId, afterSeq);

  // Resolve agent display names once (IDENTITY.md / config name).
  const nameById = new Map<string, string | undefined>();
  try {
    for (const a of resolveConfiguredAgents().agents) nameById.set(a.id, a.name);
  } catch {
    /* best-effort */
  }

  // Resolve cron job names once (jobId → human name) so the app can subtitle each
  // notification with its scheduled-task name rather than the agent name.
  const cronMetadata = await loadCronNotificationMetadata();

  const notifications = items.map((n) => {
    const jobId = cronJobIdFromSessionKey(n.sourceSessionKey) ?? n.jobId ?? "";
    const hidden = shouldHideNotification(n, cronMetadata);
    return {
      seq: n.seq,
      ts: n.ts,
      agentId: n.agentId,
      agentName: nameById.get(n.agentId),
      // Resolve the cron job's CURRENT name LIVE from its jobId (embedded in the session key
      // for message-tool crons, or captured on the record for announce crons) so renaming a
      // job updates every past notification. Fall back to the last-known captured name only
      // when the job no longer exists (live lookup returns nothing).
      jobName: cronMetadata.get(jobId)?.name || n.jobName?.trim(),
      kind: n.kind,
      text: n.text,
      hasMedia: n.hasMedia,
      ...(hidden ? { hidden: true } : {}),
    };
  });
  const maxSeq = notifications.reduce((m, n) => (n.seq > m ? n.seq : m), afterSeq);

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, notifications, maxSeq }));
  return true;
}

/**
 * DELETE /friday-next/notifications/:seq?deviceId=
 *
 * Permanently removes one notification from the device's durable server log so it can't
 * reappear on this or any other device. Idempotent: deleting a seq that is already gone
 * returns ok with deleted:false.
 */
export async function handleNotificationDelete(
  req: IncomingMessage,
  res: ServerResponse,
  seqRaw: string,
): Promise<boolean> {
  const respond = (code: number, body: Record<string, unknown>) => {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
    return true;
  };

  if (req.method !== "DELETE") return respond(405, { error: "Method Not Allowed" });
  if (!extractBearerToken(req)) {
    return respond(401, { error: "Unauthorized: bearer token mismatch" });
  }

  const url = new URL(req.url ?? "", "http://localhost");
  const deviceId = (url.searchParams.get("deviceId") ?? "").trim();
  if (!deviceId) return respond(400, { error: "Missing deviceId" });

  const seq = Number(seqRaw);
  if (!Number.isFinite(seq) || !Number.isInteger(seq)) {
    return respond(400, { error: "Invalid seq" });
  }

  const deleted = fridayNotificationsStore.delete(deviceId, seq);
  return respond(200, { ok: true, deleted });
}
