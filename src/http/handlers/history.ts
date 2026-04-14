/**
 * History handler for GET/DELETE /friday/history
 *
 * Provides conversation history for a given sessionKey.
 * Returns one aggregated "history" event with up to 20 rounds.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken } from "../middleware/auth.js";
import { getHistoryEvent, clearHistory } from "../../conversation-history.js";

const log = (action: string, sessionKey: string, detail?: string) => {
  const ts = new Date().toISOString();
  const detailPart = detail ? ` detail=${detail}` : "";
  console.error(`[Friday-HIST] [${ts}] [${action}] sessionKey=${sessionKey}${detailPart}`);
};

export async function handleHistory(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const sessionKey = url.searchParams.get("sessionKey");

  // ── GET /friday/history?sessionKey=... ──────────────────────────────────
  if (req.method === "GET") {
    if (!extractBearerToken(req)) {
      log("AUTH_FAILED", sessionKey ?? "(unknown)", "missing or invalid token");
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return true;
    }

    if (!sessionKey || sessionKey.length === 0) {
      log("BAD_REQUEST", "(unknown)", "missing sessionKey");
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Missing required query parameter: sessionKey" }));
      return true;
    }

    const sk = sessionKey;
    const historyEvent = getHistoryEvent(sk);
    log("GET", sk, `rounds=${historyEvent.rounds.length}`);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(historyEvent));
    return true;
  }

  // ── DELETE /friday/history?sessionKey=... ────────────────────────────────
  if (req.method === "DELETE") {
    if (!extractBearerToken(req)) {
      log("AUTH_FAILED", sessionKey ?? "(unknown)", "missing or invalid token");
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return true;
    }

    if (!sessionKey || sessionKey.length === 0) {
      log("BAD_REQUEST", "(unknown)", "missing sessionKey");
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Missing required query parameter: sessionKey" }));
      return true;
    }

    const sk = sessionKey;
    clearHistory(sk);
    log("DELETE", sk);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, sessionKey: sk }));
    return true;
  }

  // ── Other methods ───────────────────────────────────────────────────────
  res.statusCode = 405;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "Method Not Allowed" }));
  return true;
}
