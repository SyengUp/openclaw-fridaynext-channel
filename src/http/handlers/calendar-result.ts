/**
 * POST /friday-next/calendar/result
 * Body: { requestId, ok, payload?, error?: { code, message } }
 * Serves both fridaynext_calendar_query and fridaynext_calendar_log results.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody } from "../middleware/body.js";
import { extractBearerToken } from "../middleware/auth.js";
import {
  hasPendingCalendarRequest,
  resolveCalendarResult,
} from "../../calendar/pending-store.js";
import { createFridayNextLogger } from "../../logging.js";
import { getRuntimeV3Store } from "../../runtime-v3/runtime-store.js";
import { sseEmitter } from "../../sse/emitter.js";

export async function handleCalendarResult(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const log = createFridayNextLogger("calendar");
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
  const payload =
    body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
      ? (body.payload as Record<string, unknown>)
      : {};
  const errObj =
    body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : {};
  const code =
    typeof errObj.code === "string" && errObj.code.trim()
      ? errObj.code.trim()
      : "CALENDAR_UNAVAILABLE";
  const message =
    typeof errObj.message === "string" && errObj.message.trim()
      ? errObj.message.trim()
      : "Calendar request failed";
  const outcome = ok
    ? ({ ok: true, payload } as const)
    : ({ ok: false, error: { code, message } } as const);
  const receiptPayload = outcome;
  const store = getRuntimeV3Store();
  const durableRequest = store.deviceRequest("calendar", requestId);
  const flushRuntimeDeltas = () => {
    if (durableRequest?.runId) sseEmitter.flushRuntimeV3Run(durableRequest.runId);
  };
  const hasLiveWaiter = hasPendingCalendarRequest(requestId);
  const receiptStatus = store.commandReceiptStatus("calendar-result", requestId, receiptPayload);
  if (receiptStatus === "conflict") {
    return json(409, { error: "Result conflicts with the accepted result" });
  }
  if (receiptStatus === "replayed") {
    return json(200, { ok: true, requestId, replayed: true });
  }
  if (receiptStatus === "prepared" && !hasLiveWaiter) {
    flushRuntimeDeltas();
    store.completeDeviceRequestWithRunEvent("calendar", requestId, { ok });
    store.completeCommandReceipt("calendar-result", requestId, receiptPayload, { ok: true, requestId });
    return json(200, { ok: true, requestId, recovered: true });
  }
  if (receiptStatus === "missing") {
    if (!hasLiveWaiter && durableRequest?.state !== "pending") {
      return json(404, { error: "Unknown or expired requestId" });
    }
    store.prepareCommandReceipt("calendar-result", requestId, receiptPayload);
  }
  if (hasLiveWaiter) {
    if (!resolveCalendarResult(requestId, outcome)) {
      return json(404, { error: "Unknown or expired requestId" });
    }
  } else if (durableRequest?.state !== "pending") {
    return json(404, { error: "Unknown or expired requestId" });
  }
  flushRuntimeDeltas();
  store.completeDeviceRequestWithRunEvent("calendar", requestId, { ok });
  store.completeCommandReceipt("calendar-result", requestId, receiptPayload, { ok: true, requestId });

  if (ok) {
    const eventCount = Array.isArray(payload.events) ? payload.events.length : 0;
    const reminderCount = Array.isArray(payload.reminders) ? payload.reminders.length : 0;
    const createdCount = Array.isArray(payload.created) ? payload.created.length : 0;
    log.info(
      `calendar ${requestId} ok events=[${eventCount}] reminders=[${reminderCount}] created=[${createdCount}]`,
    );
    return json(200, { ok: true, requestId });
  }

  log.info(`calendar ${requestId} error=${code}`);
  return json(200, { ok: true, requestId });
}
