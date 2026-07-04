/**
 * GET /friday-next/notifications?deviceId=&afterSeq=
 *
 * Returns the durable log of agent-initiated background pushes (cron / heartbeat)
 * for a device. These deliver to ephemeral `cron:<id>:run:<runId>` / `:heartbeat`
 * sessions the app never shows, so they are surfaced here as a notifications inbox
 * instead. Captured at the outbound boundary regardless of connection, so pushes
 * sent while the device was offline appear on reconnect.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken } from "../middleware/auth.js";
import { fridayNotificationsStore } from "../../notifications/notifications-store.js";
import { resolveConfiguredAgents } from "./agents-list.js";
import { loadCronStore, resolveCronStorePath } from "openclaw/plugin-sdk/config-runtime";
import { cronJobIdFromSessionKey } from "../../notifications/cron-session-key.js";

/** Best-effort jobId → job-name map from the cron store (empty on any failure —
 *  the app falls back to a generic "定时任务" label when a name is absent). */
async function loadCronJobNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const store = await loadCronStore(resolveCronStorePath());
    for (const job of store.jobs) {
      const name = job.name?.trim();
      if (job.id && name) names.set(job.id, name);
    }
  } catch {
    /* best-effort — a cron-store read failure must not break the inbox */
  }
  return names;
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
  const cronJobNames = await loadCronJobNames();

  const notifications = items.map((n) => ({
    seq: n.seq,
    ts: n.ts,
    agentId: n.agentId,
    agentName: nameById.get(n.agentId),
    // Resolve the cron job's CURRENT name LIVE from its jobId (embedded in the session key
    // for message-tool crons, or captured on the record for announce crons) so renaming a
    // job updates every past notification. Fall back to the last-known captured name only
    // when the job no longer exists (live lookup returns nothing).
    jobName:
      cronJobNames.get(cronJobIdFromSessionKey(n.sourceSessionKey) ?? n.jobId ?? "") ||
      n.jobName?.trim(),
    kind: n.kind,
    text: n.text,
    hasMedia: n.hasMedia,
  }));
  const maxSeq = notifications.reduce((m, n) => (n.seq > m ? n.seq : m), afterSeq);

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, notifications, maxSeq }));
  return true;
}
