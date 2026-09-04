import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { resolveFridayNextConfig } from "../config.js";
import { registerFridaySessionDeviceMapping } from "../friday-session.js";
import { getHostOpenClawConfigSnapshot } from "../host-config.js";
import { handleMessages } from "../http/handlers/messages.js";
import { registerRunRoute } from "../run-metadata.js";
import { getFridayNextRuntime } from "../runtime.js";
import { sseEmitter } from "../sse/emitter.js";
import { getRuntimeV3Store } from "./runtime-store.js";

class RecoveryResponse {
  statusCode = 0;
  setHeader(_name: string, _value: string): void {}
  end(_body?: string): void {}
}

async function replayQueuedCommand(runId: string): Promise<void> {
  const store = getRuntimeV3Store();
  const run = store.run(runId);
  if (!run || run.phase !== "queued") return;

  const request = new PassThrough() as unknown as IncomingMessage;
  request.method = "POST";
  request.url = "/friday-next/v3/messages";
  const config = resolveFridayNextConfig(
    getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
  );
  request.headers = { authorization: `Bearer ${config.authToken}` };
  const response = new RecoveryResponse();
  const handling = handleMessages(request, response as unknown as ServerResponse);
  const options = run.sessionOptions ?? {};
  (request as unknown as PassThrough).end(
    JSON.stringify({
      deviceId: run.deviceId,
      clientRequestId: run.clientRequestId,
      sessionKey: run.sessionKey,
      text: run.text,
      attachments: run.attachments,
      ...options,
    }),
  );
  await handling;
}

/** Restore routing immediately and resume commands that were durably accepted but never claimed. */
export async function restoreDurableRuntimeV3(): Promise<{
  restoredRouteCount: number;
  resumedQueuedCount: number;
}> {
  const store = getRuntimeV3Store();
  const unfinished = store.unfinishedRuns();
  for (const run of unfinished) {
    registerFridaySessionDeviceMapping(run.sessionKey, run.deviceId);
    registerRunRoute({ runId: run.runId, deviceId: run.deviceId, sessionKey: run.sessionKey });
    sseEmitter.trackDeviceForRun(run.deviceId, run.runId);
  }

  const queued = unfinished.filter((run) => run.phase === "queued");
  await Promise.all(queued.map((run) => replayQueuedCommand(run.runId)));
  return { restoredRouteCount: unfinished.length, resumedQueuedCount: queued.length };
}
