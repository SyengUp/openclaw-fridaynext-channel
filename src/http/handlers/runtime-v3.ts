import type { IncomingMessage, ServerResponse } from "node:http";
import { abortRunForSessionKey } from "../../agent/abort-run.js";
import { markUserAbort } from "../../agent/recent-aborts.js";
import { getRuntimeV3Store } from "../../runtime-v3/runtime-store.js";
import type { DurableRuntimeEvent } from "../../runtime-v3/durable-run-store.js";
import { extractBearerToken } from "../middleware/auth.js";
import { readJsonBody } from "../middleware/body.js";
import { PLUGIN_VERSION } from "../../version.js";

function json(res: ServerResponse, status: number, body: Record<string, unknown>): boolean {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
  return true;
}

function authenticate(req: IncomingMessage, res: ServerResponse): boolean {
  if (extractBearerToken(req)) return true;
  json(res, 401, { error: "Unauthorized: bearer token mismatch" });
  return false;
}

function integerQuery(url: URL, name: string, fallback: number): number {
  const value = Number.parseInt(url.searchParams.get(name) ?? "", 10);
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function writeRuntimeEvent(res: ServerResponse, event: DurableRuntimeEvent): void {
  res.write(`id: ${event.eventId}\nevent: runtime\ndata: ${JSON.stringify(event)}\n\n`);
}

export async function handleRuntimeV3Events(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET") return json(res, 405, { error: "Method Not Allowed" });
  if (!authenticate(req, res)) return true;
  const url = new URL(req.url ?? "/", "http://localhost");
  const deviceId = (url.searchParams.get("deviceId") ?? "").trim().toUpperCase();
  if (!deviceId) return json(res, 400, { error: "Missing required query parameter: deviceId" });
  const headerId = Number.parseInt(String(req.headers["last-event-id"] ?? ""), 10);
  const afterEventId = Number.isFinite(headerId)
    ? Math.max(0, headerId)
    : integerQuery(url, "lastEventId", 0);
  const store = getRuntimeV3Store();

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let lastSent = afterEventId;
  let replaying = true;
  const arrivedDuringReplay: DurableRuntimeEvent[] = [];
  const unsubscribe = store.subscribe(deviceId, (event) => {
    if (event.eventId <= lastSent) return;
    if (replaying) {
      arrivedDuringReplay.push(event);
      return;
    }
    lastSent = event.eventId;
    writeRuntimeEvent(res, event);
  });

  const head = store.eventHead(deviceId);
  res.write(
    `event: hello\ndata: ${JSON.stringify({
      protocolVersion: 3,
      pluginVersion: PLUGIN_VERSION,
      serverInstanceId: store.serverInstanceId,
      deviceId,
      floorEventId: head > 0 ? 1 : 0,
      headEventId: head,
      acknowledgedEventId: store.acknowledgedEventId(deviceId),
      unfinishedRuns: store.unfinishedRuns(deviceId),
    })}\n\n`,
  );
  for (const event of store.eventsAfter(deviceId, afterEventId, Number.MAX_SAFE_INTEGER)) {
    if (event.eventId <= lastSent) continue;
    lastSent = event.eventId;
    writeRuntimeEvent(res, event);
  }
  replaying = false;
  for (const event of arrivedDuringReplay.sort((a, b) => a.eventId - b.eventId)) {
    if (event.eventId <= lastSent) continue;
    lastSent = event.eventId;
    writeRuntimeEvent(res, event);
  }

  const keepalive = setInterval(() => res.write(": keepalive\n\n"), 15_000);
  keepalive.unref();
  req.on("close", () => {
    clearInterval(keepalive);
    unsubscribe();
  });
  return true;
}

export async function handleRuntimeV3Acknowledge(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });
  if (!authenticate(req, res)) return true;
  const body = await readJsonBody(req);
  const deviceId = typeof body?.deviceId === "string" ? body.deviceId.trim().toUpperCase() : "";
  const throughEventId = typeof body?.throughEventId === "number" ? body.throughEventId : NaN;
  if (!deviceId || !Number.isFinite(throughEventId)) {
    return json(res, 400, { error: "Missing deviceId or throughEventId" });
  }
  const store = getRuntimeV3Store();
  const requestedInstance =
    typeof body?.serverInstanceId === "string" ? body.serverInstanceId.trim() : "";
  if (requestedInstance && requestedInstance !== store.serverInstanceId) {
    return json(res, 409, {
      error: "serverInstanceId mismatch",
      serverInstanceId: store.serverInstanceId,
    });
  }
  return json(res, 200, {
    ok: true,
    protocolVersion: 3,
    serverInstanceId: store.serverInstanceId,
    acknowledgedEventId: store.acknowledge(deviceId, throughEventId),
  });
}

export async function handleRuntimeV3Sync(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET") return json(res, 405, { error: "Method Not Allowed" });
  if (!authenticate(req, res)) return true;
  const url = new URL(req.url ?? "/", "http://localhost");
  const deviceId = (url.searchParams.get("deviceId") ?? "").trim().toUpperCase();
  if (!deviceId) return json(res, 400, { error: "Missing required query parameter: deviceId" });
  const afterEventId = integerQuery(url, "afterEventId", 0);
  const limit = Math.min(5_000, Math.max(1, integerQuery(url, "limit", 1_000)));
  const store = getRuntimeV3Store();
  const headEventId = store.eventHead(deviceId);
  const events = store.eventsAfter(deviceId, afterEventId, limit);
  return json(res, 200, {
    ok: true,
    protocolVersion: 3,
    serverInstanceId: store.serverInstanceId,
    floorEventId: headEventId > 0 ? 1 : 0,
    headEventId,
    acknowledgedEventId: store.acknowledgedEventId(deviceId),
    gapDetected: false,
    hasMore: (events.at(-1)?.eventId ?? afterEventId) < headEventId,
    events,
    runs: store.runs(deviceId),
  });
}

export async function handleRuntimeV3SessionSnapshot(
  req: IncomingMessage,
  res: ServerResponse,
  sessionKey: string,
): Promise<boolean> {
  if (req.method !== "GET") return json(res, 405, { error: "Method Not Allowed" });
  if (!authenticate(req, res)) return true;
  const key = sessionKey.trim();
  if (!key) return json(res, 400, { error: "Missing session key" });
  const store = getRuntimeV3Store();
  const runs = store.runs().filter((run) => run.sessionKey === key);
  const events = runs.flatMap((run) =>
    store
      .eventsAfter(run.deviceId, 0, Number.MAX_SAFE_INTEGER)
      .filter((event) => event.sessionKey === key),
  );
  const dedupedEvents = [...new Map(events.map((event) => [`${event.runId}:${event.runSeq}`, event])).values()]
    .sort((a, b) => a.occurredAt - b.occurredAt || a.runSeq - b.runSeq);
  return json(res, 200, {
    ok: true,
    protocolVersion: 3,
    serverInstanceId: store.serverInstanceId,
    sessionKey: key,
    revision: dedupedEvents.length,
    runs,
    events: dedupedEvents,
  });
}

export async function handleRuntimeV3Cancel(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
): Promise<boolean> {
  if (req.method !== "DELETE") return json(res, 405, { error: "Method Not Allowed" });
  if (!authenticate(req, res)) return true;
  const store = getRuntimeV3Store();
  const run = store.run(runId);
  if (!run) return json(res, 404, { error: "Unknown runId" });
  if (run.phase === "completed" || run.phase === "failed" || run.phase === "cancelled") {
    return json(res, 200, { ok: true, runId, phase: run.phase, replayed: true });
  }
  if (run.phase === "queued") {
    const event = store.appendRunEvent(runId, "run.cancelled", { reason: "cancelled before dispatch" });
    return json(res, 200, { ok: true, runId, phase: "cancelled", eventId: event.eventId });
  }

  store.transition(runId, "cancelPending");
  markUserAbort(run.sessionKey);
  const result = await abortRunForSessionKey(run.sessionKey);
  const event = store.appendRunEvent(runId, "run.cancelled", {
    reason: "user",
    aborted: result.aborted,
  });
  return json(res, 200, {
    ok: true,
    runId,
    phase: "cancelled",
    eventId: event.eventId,
    ...result,
  });
}
