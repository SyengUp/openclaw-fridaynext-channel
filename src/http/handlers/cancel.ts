import type { IncomingMessage, ServerResponse } from "node:http";
import { abortRunForSessionKey } from "../../agent/abort-run.js";
import { markUserAbort } from "../../agent/recent-aborts.js";
import { getRunRoute } from "../../run-metadata.js";
import { sseEmitter } from "../../sse/emitter.js";
import { readJsonBody } from "../middleware/body.js";
import { extractBearerToken } from "../middleware/auth.js";

export async function handleCancel(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "POST") {
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
  const body = await readJsonBody(req);
  const runId = typeof body?.runId === "string" ? body.runId.trim() : "";
  // sessionKey is the primary identifier (one active run per session); runId is a
  // back-compat fallback for older apps — resolve it to a sessionKey via the run route.
  const sessionKey =
    (typeof body?.sessionKey === "string" ? body.sessionKey.trim() : "") ||
    (runId ? (getRunRoute(runId)?.sessionKey?.trim() ?? "") : "");
  if (!sessionKey && !runId) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing sessionKey or runId" }));
    return true;
  }
  const result = sessionKey
    ? await abortRunForSessionKey(sessionKey)
    : { aborted: false };
  // Record the user stop so abort-induced error deliveries are suppressed for a short window
  // (the aborted run's own failover, or a generic failure on the immediate next turn).
  if (sessionKey) markUserAbort(sessionKey);
  if (runId) sseEmitter.untrackRun(runId);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, sessionKey, runId, cancelled: true, ...result }));
  return true;
}
