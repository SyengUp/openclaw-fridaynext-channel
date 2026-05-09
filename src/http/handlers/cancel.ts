import type { IncomingMessage, ServerResponse } from "node:http";
import { abortRun } from "../../agent/abort-run.js";
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
  if (!runId) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing runId" }));
    return true;
  }
  await abortRun(runId);
  sseEmitter.untrackRun(runId);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, runId, cancelled: true }));
  return true;
}
