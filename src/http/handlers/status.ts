import type { IncomingMessage, ServerResponse } from "node:http";
import { getActiveRunIds } from "../../agent/active-runs.js";
import { sseEmitter } from "../../sse/emitter.js";
import { extractBearerToken } from "../middleware/auth.js";

export async function handleStatus(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return true;
  }
  if (!extractBearerToken(req)) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Unauthorized: missing bearer token" }));
    return true;
  }
  const activeRuns = getActiveRunIds();
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      ok: true,
      channel: "friday-next",
      version: "v2",
      connections: sseEmitter.getConnectionCount(),
      activeRuns,
      activeRunCount: activeRuns.length,
    }),
  );
  return true;
}
