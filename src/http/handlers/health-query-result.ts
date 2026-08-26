/**
 * POST /friday-next/health-query/result
 * Body: { requestId, ok, payload?, error?: { code, message } }
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody } from "../middleware/body.js";
import { extractBearerToken } from "../middleware/auth.js";
import { resolveHealthQueryResult } from "../../health-query/pending-store.js";
import { createFridayNextLogger } from "../../logging.js";

export async function handleHealthQueryResult(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const log = createFridayNextLogger("health-query");
  const json = (status: number, body: Record<string, unknown>) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
    return true;
  };

  if (req.method !== "POST") return json(405, { error: "Method Not Allowed" });
  if (!extractBearerToken(req)) return json(401, { error: "Unauthorized: bearer token mismatch" });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: "Invalid JSON body" });

  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  if (!requestId) return json(400, { error: "Missing requestId" });

  const ok = body.ok === true;
  if (ok) {
    const payload =
      body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
        ? (body.payload as Record<string, unknown>)
        : {};
    if (!resolveHealthQueryResult(requestId, { ok: true, payload })) {
      return json(404, { error: "Unknown or expired requestId" });
    }
    const auth =
      payload.authorization && typeof payload.authorization === "object"
        ? JSON.stringify(payload.authorization)
        : "{}";
    const metricKeys =
      payload.metrics && typeof payload.metrics === "object" && !Array.isArray(payload.metrics)
        ? Object.keys(payload.metrics as Record<string, unknown>).join(",")
        : "";
    log.info(`health-query ${requestId} ok metrics=[${metricKeys}] auth=${auth}`);
    return json(200, { ok: true, requestId });
  }

  const errObj = body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : {};
  const code = typeof errObj.code === "string" && errObj.code.trim() ? errObj.code.trim() : "HEALTH_UNAVAILABLE";
  const message =
    typeof errObj.message === "string" && errObj.message.trim()
      ? errObj.message.trim()
      : "Health query failed";
  if (!resolveHealthQueryResult(requestId, { ok: false, error: { code, message } })) {
    return json(404, { error: "Unknown or expired requestId" });
  }
  log.info(`health-query ${requestId} error=${code}`);
  return json(200, { ok: true, requestId });
}
