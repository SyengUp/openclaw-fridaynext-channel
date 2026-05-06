import type { IncomingMessage, ServerResponse } from "node:http";
import { deleteFridaySession } from "../../session/session-manager.js";
import { readJsonBody } from "../middleware/body.js";
import { extractBearerToken } from "../middleware/auth.js";

export async function handleSessionsDelete(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "DELETE") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return true;
  }

  const token = extractBearerToken(req);
  if (!token) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return true;
  }

  const body = await readJsonBody(req);
  const sessionKey = typeof body?.sessionKey === "string" ? body.sessionKey.trim() : "";
  if (!sessionKey) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing required field: sessionKey" }));
    return true;
  }

  const result = deleteFridaySession(sessionKey);

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, ...result }));
  return true;
}
