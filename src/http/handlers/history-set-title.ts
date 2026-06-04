/**
 * PUT /friday-next/sessions/title  body: { sessionKey, title }
 *
 * Syncs the app-set session name to the server session's `displayName` (the
 * field OpenClaw resolves first for a session's display title, ahead of `label`).
 * Writes via `updateSessionStoreEntry` (cache-owning, not request-scoped), so the
 * change is also visible to webui and other clients.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getFridayAgentForwardRuntime } from "../../agent-forward-runtime.js";
import { extractBearerToken } from "../middleware/auth.js";
import { readJsonBody } from "../middleware/body.js";
import { agentIdFromSessionKey, toSessionStoreKey } from "../../session/session-manager.js";

function json(res: ServerResponse, status: number, body: unknown): true {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
  return true;
}

/** Real store key matching `sessionKey`, tolerating deviceId case differences. */
function resolveStoreKey(store: Record<string, unknown>, sessionKey: string): string | undefined {
  if (store[sessionKey]) return sessionKey;
  const canonical = toSessionStoreKey(sessionKey);
  if (store[canonical]) return canonical;
  const target = canonical.toLowerCase();
  for (const k of Object.keys(store)) {
    if (k.toLowerCase() === target) return k;
  }
  return undefined;
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
  if (!rt?.updateSessionStoreEntry) {
    return json(res, 503, { error: "Session store write not available" });
  }

  const agentId = agentIdFromSessionKey(sessionKey);
  let storePath: string;
  let store: Record<string, unknown>;
  try {
    storePath = rt.resolveStorePath(undefined, { agentId });
    store = rt.loadSessionStore(storePath) ?? {};
  } catch {
    return json(res, 500, { error: "Failed to load session store" });
  }

  const storeKey = resolveStoreKey(store, sessionKey);
  if (!storeKey) {
    return json(res, 404, { error: `Session not found: ${sessionKey}` });
  }

  try {
    const updated = await rt.updateSessionStoreEntry({
      storePath,
      sessionKey: storeKey,
      // Empty title clears the override so the server can derive its own again.
      update: () => ({ displayName: title || undefined }),
    });
    const sessionId =
      updated && typeof updated.sessionId === "string" ? updated.sessionId : undefined;
    return json(res, 200, { ok: true, sessionKey, ...(sessionId ? { sessionId } : {}), title });
  } catch {
    return json(res, 500, { error: "Failed to update session title" });
  }
}
