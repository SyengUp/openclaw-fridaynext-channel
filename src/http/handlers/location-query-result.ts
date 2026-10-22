import { completeDeviceResult } from "@syengup/fridaynext-channel-kit/device-request/results";
import {
  operationResult,
  writeOperation,
  type OpenClawOperationResult,
} from "../../adapters/openclaw/operation-result.js";
/**
 * POST /friday-next/location/result
 * Body: { requestId, ok, payload?, error?: { code, message } }
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody } from "../middleware/body.js";
import { extractBearerToken } from "../middleware/auth.js";
import {
  hasPendingLocationQuery,
  resolveLocationQueryResult,
} from "../../location/pending-store.js";
import { createFridayNextLogger } from "../../logging.js";
import { getRuntimeV3Store } from "../../runtime-v3/runtime-store.js";
import { sseEmitter } from "../../sse/emitter.js";

export async function handleLocationQueryResult(
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
  return writeOperation(res, await submitOpenClawLocationResult(await readJsonBody(req)));
}

export async function submitOpenClawLocationResult(
  body: Record<string, unknown> | null,
): Promise<OpenClawOperationResult> {
  const log = createFridayNextLogger("location-query");
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
      : "LOCATION_UNAVAILABLE";
  const message =
    typeof errObj.message === "string" && errObj.message.trim()
      ? errObj.message.trim()
      : "Location query failed";
  const outcome = ok
    ? ({ ok: true, payload } as const)
    : ({ ok: false, error: { code, message } } as const);
  const result = completeDeviceResult(
    {
      kind: "location",
      store: getRuntimeV3Store(),
      hasPending: hasPendingLocationQuery,
      resolve: resolveLocationQueryResult,
      flush: (runId) => sseEmitter.flushRuntimeV3Run(runId),
    },
    requestId,
    outcome,
  );
  if (result.status !== 200 || result.body.replayed || result.body.recovered) return result;

  if (ok) {
    log.info(
      `location-query ${requestId} ok lat=${String(payload.latitude)} lng=${String(payload.longitude)}`,
    );
    return json(200, { ok: true, requestId });
  }

  log.info(`location-query ${requestId} error=${code}`);
  return json(200, { ok: true, requestId });
}
