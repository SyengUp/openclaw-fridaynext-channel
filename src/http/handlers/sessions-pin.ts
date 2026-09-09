/**
 * PUT /friday-next/sessions/pin  body: { sessionKey, pinned }
 *
 * 对接 OpenClaw 的原生置顶事实：pinnedAt 决定是否置顶，重复置顶不刷新时间戳。
 * 优先使用按会话身份写入的 patchSessionEntry；旧宿主回退到 JSON store 写入器。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getFridayAgentForwardRuntime } from "../../agent-forward-runtime.js";
import { findSessionStoreRow } from "../../history/session-store-access.js";
import { agentIdFromSessionKey } from "../../session/session-manager.js";
import { extractBearerToken } from "../middleware/auth.js";
import { readJsonBody } from "../middleware/body.js";

function json(res: ServerResponse, status: number, body: unknown): true {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
  return true;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pinPatch(entry: Record<string, unknown>, pinned: boolean): Record<string, unknown> {
  if (!pinned) {
    return { pinned: false, pinnedAt: undefined };
  }
  return { pinned: true, pinnedAt: finiteNumber(entry.pinnedAt) ?? Date.now() };
}

export async function handleSessionsPin(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "PUT") {
    return json(res, 405, { error: "Method Not Allowed" });
  }
  if (!extractBearerToken(req)) {
    return json(res, 401, { error: "Unauthorized: bearer token mismatch" });
  }

  const body = (await readJsonBody(req)) as { sessionKey?: unknown; pinned?: unknown } | null;
  const sessionKey = typeof body?.sessionKey === "string" ? body.sessionKey.trim() : "";
  if (!sessionKey) {
    return json(res, 400, { error: "Missing required field: sessionKey" });
  }
  if (typeof body?.pinned !== "boolean") {
    return json(res, 400, { error: "Field pinned must be a boolean" });
  }
  const pinned = body.pinned;

  const rt = getFridayAgentForwardRuntime();
  if (!rt?.patchSessionEntry && !rt?.updateSessionStoreEntry) {
    return json(res, 503, { error: "Session store write not available" });
  }

  const row = findSessionStoreRow(sessionKey);
  if (!row) {
    return json(res, 404, { error: `Session not found: ${sessionKey}` });
  }

  const agentId = agentIdFromSessionKey(row.sessionKey);
  let updated: Record<string, unknown> | null = null;

  if (rt.patchSessionEntry) {
    try {
      updated = await rt.patchSessionEntry({
        sessionKey: row.sessionKey,
        agentId,
        preserveActivity: true,
        update: (entry) => pinPatch(entry, pinned),
      });
    } catch {
      // 新写入器异常时仍尝试旧宿主兼容路径，避免一次能力探测失败阻断操作。
    }
  }

  if (!updated && rt.updateSessionStoreEntry) {
    try {
      const storePath = rt.resolveStorePath(undefined, { agentId });
      updated = await rt.updateSessionStoreEntry({
        storePath,
        sessionKey: row.sessionKey,
        update: (entry) => pinPatch(entry, pinned),
      });
    } catch {
      return json(res, 500, { error: "Failed to update session pin" });
    }
  }

  if (!updated) {
    return json(res, 500, { error: "Failed to update session pin" });
  }

  const pinnedAt = finiteNumber(updated.pinnedAt);
  if ((pinned && pinnedAt === undefined) || (!pinned && pinnedAt !== undefined)) {
    return json(res, 500, { error: "Failed to update session pin" });
  }

  return json(res, 200, {
    ok: true,
    sessionKey,
    pinned,
    ...(pinnedAt !== undefined && pinned ? { pinnedAt } : {}),
  });
}
