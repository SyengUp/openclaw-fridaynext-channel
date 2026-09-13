/**
 * 旧 App 兼容投影。数据源已经切换为 inbox-v2 的 `cron_changed.finished` 精确日志，
 * 因此该接口只可能返回 cron；普通 outbound、push、heartbeat、worker 不再写入。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { cronResultStore } from "../../inbox/cron-result-store.js";
import { extractBearerToken } from "../middleware/auth.js";
import { resolveConfiguredAgents } from "./agents-list.js";

function json(res: ServerResponse, status: number, body: Record<string, unknown>): true {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
  return true;
}

export async function handleNotifications(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET") return json(res, 405, { error: "Method Not Allowed" });
  if (!extractBearerToken(req)) {
    return json(res, 401, { error: "Unauthorized: bearer token mismatch" });
  }
  const url = new URL(req.url ?? "", "http://localhost");
  const deviceId = (url.searchParams.get("deviceId") ?? "").trim();
  if (!deviceId) return json(res, 400, { error: "Missing deviceId" });
  const afterSeqRaw = Number(url.searchParams.get("afterSeq") ?? "0");
  const afterSeq = Number.isFinite(afterSeqRaw) ? afterSeqRaw : 0;

  const nameById = new Map<string, string | undefined>();
  try {
    for (const agent of resolveConfiguredAgents().agents) nameById.set(agent.id, agent.name);
  } catch {
    /* 名称是展示增强，不影响结构化分类。 */
  }
  const notifications = cronResultStore.readAfter(deviceId, afterSeq).map((record) => ({
    seq: record.cursor,
    ts: record.occurredAtMs,
    agentId: record.agentId,
    agentName: nameById.get(record.agentId),
    jobName: record.jobName,
    kind: "cron",
    text: record.summary ?? record.error ?? record.deliveryError ?? "",
    hasMedia: false,
  }));
  const maxSeq = Math.max(afterSeq, cronResultStore.currentCursor(deviceId));
  return json(res, 200, { ok: true, notifications, maxSeq });
}

export async function handleNotificationDelete(
  req: IncomingMessage,
  res: ServerResponse,
  seqRaw: string,
): Promise<boolean> {
  if (req.method !== "DELETE") return json(res, 405, { error: "Method Not Allowed" });
  if (!extractBearerToken(req)) {
    return json(res, 401, { error: "Unauthorized: bearer token mismatch" });
  }
  const url = new URL(req.url ?? "", "http://localhost");
  const deviceId = (url.searchParams.get("deviceId") ?? "").trim();
  if (!deviceId) return json(res, 400, { error: "Missing deviceId" });
  const seq = Number(seqRaw);
  if (!Number.isSafeInteger(seq)) return json(res, 400, { error: "Invalid seq" });
  return json(res, 200, { ok: true, deleted: cronResultStore.delete(deviceId, seq) });
}
