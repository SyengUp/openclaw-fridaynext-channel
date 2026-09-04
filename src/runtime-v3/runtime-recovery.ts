import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { resolveFridayNextConfig } from "../config.js";
import { registerFridaySessionDeviceMapping } from "../friday-session.js";
import { getHostOpenClawConfigSnapshot } from "../host-config.js";
import { handleMessages } from "../http/handlers/messages.js";
import { registerRunRoute } from "../run-metadata.js";
import { getFridayNextRuntime } from "../runtime.js";
import { sseEmitter } from "../sse/emitter.js";
import { readSessionTranscriptRawMessages } from "../history/read-transcript.js";
import { toSessionStoreKey } from "../session/session-manager.js";
import type { DurableRunRecord } from "./durable-run-store.js";
import { getRuntimeV3Store } from "./runtime-store.js";

class RecoveryResponse {
  statusCode = 0;
  setHeader(_name: string, _value: string): void {}
  end(_body?: string): void {}
}

async function replayQueuedCommand(runId: string): Promise<boolean> {
  const store = getRuntimeV3Store();
  const run = store.run(runId);
  if (!run || run.phase !== "queued") return false;

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
  return response.statusCode === 202;
}

export type RuntimeRecoveryDeps = {
  isRunActive: (run: DurableRunRecord) => Promise<boolean>;
  transcriptProvesCompletion: (run: DurableRunRecord) => boolean;
};

async function defaultIsRunActive(run: DurableRunRecord): Promise<boolean> {
  if (process.env.VITEST === "true") return false;
  try {
    const harness = await import("openclaw/plugin-sdk/agent-harness");
    for (const key of new Set([run.sessionKey, toSessionStoreKey(run.sessionKey)])) {
      if (harness.resolveActiveEmbeddedRunSessionId(key)) return true;
    }
  } catch {
    // A host without the optional active-run introspection cannot prove the run is alive.
  }
  return false;
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const record = part as Record<string, unknown>;
      return typeof record.text === "string" ? [record.text] : [];
    })
    .join("");
}

function messageTimestamp(message: Record<string, unknown>): number | undefined {
  const envelope = message.__openclaw;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return undefined;
  const timestamp = (envelope as Record<string, unknown>).recordTimestampMs;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : undefined;
}

function defaultTranscriptProvesCompletion(run: DurableRunRecord): boolean {
  const messages = readSessionTranscriptRawMessages(run.sessionKey, 200).filter(
    (value): value is Record<string, unknown> =>
      !!value && typeof value === "object" && !Array.isArray(value),
  );
  const userIndex = messages.findIndex((message) => {
    if (message.role !== "user") return false;
    const sameRequest = [message.clientRequestId, message.idempotencyKey].some(
      (value) => value === run.clientRequestId,
    );
    if (sameRequest) return true;
    const timestamp = messageTimestamp(message);
    return timestamp !== undefined && timestamp >= run.createdAt && messageText(message).trim() === run.text.trim();
  });
  if (userIndex < 0) return false;
  return messages.slice(userIndex + 1).some((message) => {
    if (message.role !== "assistant") return false;
    const timestamp = messageTimestamp(message);
    if (timestamp !== undefined && timestamp < run.createdAt) return false;
    if (typeof message.content === "string") return message.content.trim().length > 0;
    return Array.isArray(message.content) && message.content.length > 0;
  });
}

async function reconcileInterruptedRun(
  run: DurableRunRecord,
  deps: RuntimeRecoveryDeps,
): Promise<void> {
  const store = getRuntimeV3Store();
  const originalPhase = run.phase;
  store.transition(run.runId, "reconciling");
  store.appendRunEvent(run.runId, "run.reconciling", { previousPhase: originalPhase });

  if (await deps.isRunActive(run)) {
    store.transition(run.runId, "running");
    store.appendRunEvent(run.runId, "run.recovered", { previousPhase: originalPhase });
    return;
  }
  if (originalPhase === "cancelPending") {
    store.appendRunEvent(run.runId, "run.cancelled", { reason: "cancel resumed after plugin restart" });
    store.transition(run.runId, "cancelled", "plugin_restart_cancelled");
    return;
  }
  if (deps.transcriptProvesCompletion(run)) {
    store.appendRunEvent(run.runId, "run.completed", {
      recoveredFromTranscript: true,
      previousPhase: originalPhase,
    });
    return;
  }
  store.appendRunEvent(run.runId, "run.failed", {
    error: "plugin restarted before a terminal state was persisted",
    previousPhase: originalPhase,
  });
  store.transition(run.runId, "failed", "plugin_restart_unrecoverable");
}

/** Restore routing immediately and resume commands that were durably accepted but never claimed. */
export async function restoreDurableRuntimeV3(overrides?: Partial<RuntimeRecoveryDeps>): Promise<{
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
  const interrupted = unfinished.filter((run) => run.phase !== "queued");
  const deps: RuntimeRecoveryDeps = {
    isRunActive: overrides?.isRunActive ?? defaultIsRunActive,
    transcriptProvesCompletion: overrides?.transcriptProvesCompletion ?? defaultTranscriptProvesCompletion,
  };
  const [resumed] = await Promise.all([
    Promise.all(queued.map((run) => replayQueuedCommand(run.runId))),
    Promise.all(interrupted.map((run) => reconcileInterruptedRun(run, deps))),
  ]);
  return {
    restoredRouteCount: unfinished.length,
    resumedQueuedCount: resumed.filter(Boolean).length,
  };
}
