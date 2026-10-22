import { completeDeviceResult } from "@syengup/fridaynext-channel-kit/device-request/results";
import {
  operationResult,
  writeOperation,
  type OpenClawOperationResult,
} from "../../adapters/openclaw/operation-result.js";
/**
 * POST /friday-next/calendar/result
 * Body: { requestId, ok, payload?, error?: { code, message } }
 * Serves both fridaynext_calendar_query and fridaynext_calendar_log results.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody } from "../middleware/body.js";
import { extractBearerToken } from "../middleware/auth.js";
import { hasPendingCalendarRequest, resolveCalendarResult } from "../../calendar/pending-store.js";
import { createFridayNextLogger } from "../../logging.js";
import { getRuntimeV3Store } from "../../runtime-v3/runtime-store.js";
import { sseEmitter } from "../../sse/emitter.js";

export async function handleCalendarResult(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "POST")
    return writeOperation(res, operationResult(405, { error: "Method Not Allowed" }));
  if (!extractBearerToken(req))
    return writeOperation(
      res,
      operationResult(401, { error: "Unauthorized: bearer token mismatch" }),
    );
  return writeOperation(res, await submitOpenClawCalendarResult(await readJsonBody(req)));
}

export async function submitOpenClawCalendarResult(
  body: Record<string, unknown> | null,
): Promise<OpenClawOperationResult> {
  const log = createFridayNextLogger("calendar");
  const json = operationResult;

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
  const result = completeDeviceResult(
    {
      kind: "calendar",
      store: getRuntimeV3Store(),
      hasPending: hasPendingCalendarRequest,
      resolve: resolveCalendarResult,
      flush: (runId) => sseEmitter.flushRuntimeV3Run(runId),
    },
    requestId,
    outcome,
  );
  if (result.status !== 200 || result.body.replayed || result.body.recovered) return result;

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
