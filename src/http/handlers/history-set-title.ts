/**
 * PUT /friday-next/sessions/title  body: { sessionKey, title }
 *
 * Syncs the app-set session name to the server session's `displayName` (the
 * field OpenClaw resolves first for a session's display title, ahead of `label`).
 * Prefers `patchSessionEntry` (SQLite identity write on 2026.8.1+). Falls back
 * to `updateSessionStoreEntry` on hosts that only expose the JSON-map writer.
 *
 * COMPAT(openclaw<2026.8.1) — the `updateSessionStoreEntry` + `loadSessionStore` path.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getFridayAgentForwardRuntime } from "../../agent-forward-runtime.js";
import { extractBearerToken } from "../middleware/auth.js";
import { readJsonBody } from "../middleware/body.js";
import { agentIdFromSessionKey } from "../../session/session-manager.js";
import { findSessionStoreRow } from "../../history/session-store-access.js";

function json(res: ServerResponse, status: number, body: unknown): true {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
  return true;
}

export async function handleHistorySetTitle(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "PUT" && req.method !== "POST") {
    return json(res, 405, { error: "Method Not Allowed" });
  }
  if (!extractBearerToken(req)) {
    return json(res, 401, { error: "Unauthorized: bearer token mismatch" });
  }

  const body = (await readJsonBody(req)) as { sessionKey?: unknown; title?: unknown } | null;
  const sessionKey = typeof body?.sessionKey === "string" ? body.sessionKey.trim() : "";
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!sessionKey) {
    return json(res, 400, { error: "Missing required field: sessionKey" });
  }

  const rt = getFridayAgentForwardRuntime();
  if (!rt?.patchSessionEntry && !rt?.updateSessionStoreEntry) {
    return json(res, 503, { error: "Session store write not available" });
  }

  const row = findSessionStoreRow(sessionKey);
  if (!row) {
    return json(res, 404, { error: `Session not found: ${sessionKey}` });
  }

  const agentId = agentIdFromSessionKey(row.sessionKey);
  // Empty title clears the override so the server can derive its own again.
  const patch = () => ({ displayName: title || undefined });

  try {
    if (rt.patchSessionEntry) {
      const updated = await rt.patchSessionEntry({
        sessionKey: row.sessionKey,
        agentId,
        preserveActivity: true,
        update: patch,
      });
      const sessionId =
        updated && typeof updated.sessionId === "string" ? updated.sessionId : undefined;
      return json(res, 200, { ok: true, sessionKey, ...(sessionId ? { sessionId } : {}), title });
    }

    const storePath = rt.resolveStorePath(undefined, { agentId });
    const updated = await rt.updateSessionStoreEntry!({
      storePath,
      sessionKey: row.sessionKey,
      update: patch,
    });
    const sessionId =
      updated && typeof updated.sessionId === "string" ? updated.sessionId : undefined;
    return json(res, 200, { ok: true, sessionKey, ...(sessionId ? { sessionId } : {}), title });
  } catch {
    return json(res, 500, { error: "Failed to update session title" });
  }
}
