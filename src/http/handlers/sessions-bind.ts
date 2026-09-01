/**
 * POST /friday-next/sessions/bind  body: { deviceId, sessionKey }
 *
 * Attaches a device to a session's live stream. This is how the app starts
 * receiving a conversation that was begun elsewhere (Control UI, WebChat, another
 * client): from now on every `agent` frame for that session is forwarded to the
 * device, and the session's buffered frames (see `session-replay-buffer.ts`) are
 * injected into the device's durable SSE queue so an in-progress or just-finished
 * run renders immediately. Idempotent: rebinding the same device/session is a
 * no-op apart from re-injecting the buffer (the app's per-run seq dedup drops
 * duplicates).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken } from "../middleware/auth.js";
import { readJsonBody } from "../middleware/body.js";
import { bindFridayDeviceToSession } from "../../friday-session.js";

function json(res: ServerResponse, status: number, body: unknown): true {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
  return true;
}

export async function handleSessionsBind(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method Not Allowed" });
  }
  if (!extractBearerToken(req)) {
    return json(res, 401, { error: "Unauthorized: bearer token mismatch" });
  }

  const body = (await readJsonBody(req)) as {
    deviceId?: unknown;
    sessionKey?: unknown;
  } | null;
  const deviceId =
    typeof body?.deviceId === "string" ? body.deviceId.trim().toUpperCase() : "";
  const sessionKey = typeof body?.sessionKey === "string" ? body.sessionKey.trim() : "";
  if (!deviceId) {
    return json(res, 400, { error: "Missing required field: deviceId" });
  }
  if (!sessionKey) {
    return json(res, 400, { error: "Missing required field: sessionKey" });
  }

  const replayed = bindFridayDeviceToSession(sessionKey, deviceId);
  return json(res, 200, { ok: true, deviceId, sessionKey, replayed });
}