import { getPushRuntime } from "../../push/push-runtime.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import { abortRunForSessionKey } from "../../agent/abort-run.js";
import { markUserAbort } from "../../agent/recent-aborts.js";
import { getRuntimeV3Store } from "../../runtime-v3/runtime-store.js";
import type { DurableRuntimeEvent } from "../../runtime-v3/durable-run-store.js";
import { extractBearerToken } from "../middleware/auth.js";
import { readJsonBody } from "../middleware/body.js";
import { PLUGIN_VERSION } from "../../version.js";
import { normalizeHistoryMessages } from "../../history/normalize-message.js";
import { readSessionTranscriptRawMessages } from "../../history/read-transcript.js";
import { resolveHistoryMessageMedia } from "./history-messages.js";
import { readSessionUsageSnapshot } from "../../session-usage-store.js";
import { sseEmitter } from "../../sse/emitter.js";

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

function writeRuntimeEvent(res: ServerResponse, event: DurableRuntimeEvent): boolean {
  return res.write(`id: ${event.eventId}\nevent: runtime\ndata: ${JSON.stringify(event)}\n\n`);
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
  let waitingDrain = false;
  let replaying = true;
  let closed = false;
  const replayBatchLimit = 256;

  function pumpReplay(): void {
    if (closed || waitingDrain) return;
    replaying = true;
    while (!waitingDrain) {
      const events = store.eventsAfter(deviceId, lastSent, replayBatchLimit);
      if (events.length === 0) {
        replaying = false;
        return;
      }
      for (const event of events) {
        if (event.eventId <= lastSent) continue;
        lastSent = event.eventId;
        if (!writeRuntimeEvent(res, event)) {
          waitingDrain = true;
          return;
        }
      }
    }
  }

  const unsubscribe = store.subscribe(deviceId, (event) => {
    if (event.eventId <= lastSent) return;
    // 回放或背压期间事件已在持久化日志中，只保留游标，避免慢连接堆出无界内存队列。
    if (replaying || waitingDrain) return;
    lastSent = event.eventId;
    if (!writeRuntimeEvent(res, event)) {
      waitingDrain = true;
      replaying = true;
    }
  });

  const handleDrain = (): void => {
    waitingDrain = false;
    pumpReplay();
  };
  res.on("drain", handleDrain);

  const head = store.eventHead(deviceId);
  const floor = store.eventFloor(deviceId);
  waitingDrain = !res.write(
    `event: hello\ndata: ${JSON.stringify({
      protocolVersion: 3,
      pluginVersion: PLUGIN_VERSION,
      serverInstanceId: store.serverInstanceId,
      deviceId,
      floorEventId: floor,
      headEventId: head,
      acknowledgedEventId: store.acknowledgedEventId(deviceId),
      unfinishedRuns: store.unfinishedRuns(deviceId),
      pendingDeviceRequests: store.pendingDeviceRequests(deviceId),
    })}\n\n`,
  );
  lastSent = floor > 0 && afterEventId < floor - 1 ? floor - 1 : afterEventId;
  pumpReplay();

  const keepalive = setInterval(() => {
    if (closed || waitingDrain) return;
    if (!res.write(": keepalive\n\n")) {
      waitingDrain = true;
      replaying = true;
    }
  }, 15_000);
  keepalive.unref();
  req.on("close", () => {
    closed = true;
    clearInterval(keepalive);
    res.off("drain", handleDrain);
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
  const floorEventId = store.eventFloor(deviceId);
  const gapDetected = floorEventId > 0 && afterEventId < floorEventId - 1;
  const effectiveAfterEventId = gapDetected ? floorEventId - 1 : afterEventId;
  const events = store.eventsAfter(deviceId, effectiveAfterEventId, limit);
  return json(res, 200, {
    ok: true,
    protocolVersion: 3,
    serverInstanceId: store.serverInstanceId,
    floorEventId,
    headEventId,
    acknowledgedEventId: store.acknowledgedEventId(deviceId),
    gapDetected,
    hasMore: (events.at(-1)?.eventId ?? effectiveAfterEventId) < headEventId,
    events,
    runs: store.runs(deviceId),
    pendingDeviceRequests: store.pendingDeviceRequests(deviceId),
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
  const url = new URL(req.url ?? "/", "http://localhost");
  const requestedRunIds = new Set(
    url.searchParams
      .getAll("runId")
      .map((runId) => runId.trim())
      .filter(Boolean),
  );
  const segmentScope = url.searchParams.get("segments");
  const latestRunId = runs.at(-1)?.runId;
  const selectedRunIds =
    segmentScope === "none"
      ? new Set<string>()
      : requestedRunIds.size > 0
        ? requestedRunIds
        : new Set([
            ...runs
              .filter(
                (run) =>
                  run.phase !== "completed" && run.phase !== "failed" && run.phase !== "cancelled",
              )
              .map((run) => run.runId),
            ...(latestRunId ? [latestRunId] : []),
          ]);
  const dedupedEvents = runs
    .filter((run) => selectedRunIds.has(run.runId))
    .flatMap((run) => store.eventsForRun(run.runId))
    .sort((a, b) => a.occurredAt - b.occurredAt || a.runSeq - b.runSeq);
  const transcriptLimit = Math.min(500, Math.max(1, integerQuery(url, "transcriptLimit", 110)));
  const transcript = normalizeHistoryMessages(
    readSessionTranscriptRawMessages(key, transcriptLimit),
  );
  resolveHistoryMessageMedia(transcript);
  const sessionUsage = await readSessionUsageSnapshot(key);
  const revision = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        transcript: transcript.map((message) => [message.id, message.seq, message.ts]),
        runs: runs.map((run) => [run.runId, run.phase, run.lastRunSeq, run.updatedAt]),
        segmentHead: dedupedEvents.map((event) => [event.runId, event.runSeq, event.eventType]),
      }),
    )
    .digest("hex");
  return json(res, 200, {
    ok: true,
    protocolVersion: 3,
    serverInstanceId: store.serverInstanceId,
    sessionKey: key,
    revision,
    runs,
    transcript,
    segments: dedupedEvents,
    pendingDeviceRequests: store
      .pendingDeviceRequests()
      .filter((request) => request.sessionKey === key),
    ...(sessionUsage ? { sessionUsage } : {}),
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
    sseEmitter.flushRuntimeV3Run(runId);
    const event = store.appendRunEvent(runId, "run.cancelled", {
      reason: "cancelled before dispatch",
    });
    return json(res, 200, { ok: true, runId, phase: "cancelled", eventId: event.eventId });
  }

  getPushRuntime().cancel(runId);
  store.transition(runId, "cancelPending");
  markUserAbort(run.sessionKey);
  const result = await abortRunForSessionKey(run.sessionKey);
  sseEmitter.flushRuntimeV3Run(runId);
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
