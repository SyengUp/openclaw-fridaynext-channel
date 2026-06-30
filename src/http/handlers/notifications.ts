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

  const notifications = items.map((n) => ({
    seq: n.seq,
    ts: n.ts,
    agentId: n.agentId,
    agentName: nameById.get(n.agentId),
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
