import type { ControlRequest, RuntimeCompatibility } from "@syengup/fridaynext-channel-kit";
import type { IncomingMessage } from "node:http";
import { canonicalizeRuntimeEvent } from "../../adapters/openclaw/canonical-events.js";
import { lookupOpenClawControl } from "../../adapters/openclaw/control-adapter.js";
import { canonicalHistory } from "../../adapters/openclaw/history-projection.js";
import { describeSession, logicalSessionKey } from "../../adapters/openclaw/session-metadata.js";
import { abortRunForSessionKey } from "../../agent/abort-run.js";
import { markUserAbort } from "../../agent/recent-aborts.js";
import { normalizeHistoryMessages } from "../../history/normalize-message.js";
import {
  readSessionTranscriptRawMessages,
  resolveSessionId,
} from "../../history/read-transcript.js";
import { resolveHistoryMessageMedia, ownedHistoryRequests, historyRunRequests, historyUserTexts } from "../../http/handlers/history-messages.js";
import { createFridayNextLogger } from "../../logging.js";
import { getRuntimeV3Store } from "../../runtime-v3/runtime-store.js";
import { readSessionUsageSnapshot } from "../../session-usage-store.js";
import { toSessionStoreKey } from "../../session/session-manager.js";
import { sseEmitter } from "../../sse/emitter.js";

// 原生历史与执行状态留在宿主适配器，HTTP/SSE、背压、ACK 和快照组装由公共库实现。
export function openClawTransportOptions(request: IncomingMessage): RuntimeCompatibility {
  const canonical = request.headers["x-fridaynext-event-format"] === "canonical-v1";
  return {
    serialize: (request, event) =>
      request.headers["x-fridaynext-event-format"] === "canonical-v1"
        ? canonicalizeRuntimeEvent(event)
        : getRuntimeV3Store().legacyEvent(event),
    serializeRun: (_request, run) =>
      canonical ? { ...run, sessionKey: logicalSessionKey(run.sessionKey) } : run,
    serializeDeviceRequest: (_request, value) => {
      if (!canonical) return value;
      const { sourceEventType, ...remaining } = value;
      return {
        ...remaining,
        sessionKey: logicalSessionKey(value.sessionKey),
        kind: sourceEventType?.replace(/^fridaynext-/, "") ?? value.kind,
      };
    },
    resolveSessionKey: (key) => toSessionStoreKey(key),
    legacySnapshot: (key, limit) => readOpenClawSnapshot(key, limit, false),
    legacyCancel: async (run) => {
      markUserAbort(run.sessionKey);
      const result = await abortRunForSessionKey(run.sessionKey);
      return result;
    },
    subscribeLive: (deviceId, listener) => sseEmitter.subscribeRuntimeLive(deviceId, listener),
    flush: (runId) => sseEmitter.flushRuntimeV3Run(runId),
    logger: createFridayNextLogger("runtime-v3", "info"),
  };
}

export async function readOpenClawSnapshot(key: string, requestedLimit: number, canonical = true) {
  const limit = Math.min(500, Math.max(1, requestedLimit));
  for (let attempt = 0; attempt < 2; attempt++) {
    const sessionId = resolveSessionId(key);
    const normalized = normalizeHistoryMessages(readSessionTranscriptRawMessages(key, limit));
    const transcript = canonical
      ? canonicalHistory(
          normalized,
          ownedHistoryRequests(key),
          historyRunRequests(key),
          { userTextByRequest: historyUserTexts(key) },
        )
      : normalized;
    resolveHistoryMessageMedia(transcript);
    const sessionUsage = await readSessionUsageSnapshot(key);
    if (sessionId === resolveSessionId(key)) {
      const ids = new Set<string>();
      if (canonical)
        for (const run of getRuntimeV3Store()
          .unfinishedRuns()
          .filter((run) => run.sessionKey === key)) {
          for (const event of getRuntimeV3Store().eventsForRun(run.runId)) {
            const payload = canonicalizeRuntimeEvent(event).payload as {
              updates?: Array<{ kind: string; id?: string }>;
            };
            for (const update of payload.updates ?? [])
              if (update.kind === "control" && update.id) ids.add(update.id);
          }
        }
      const controls = canonical
        ? (await Promise.all([...ids].map((id) => lookupOpenClawControl(id)))).filter(
            (value): value is ControlRequest => value !== null && value.status === "pending",
          )
        : [];
      return {
        sessionId,
        transcript,
        sessionUsage,
        ...(canonical ? { session: describeSession(key, sessionId), controls } : {}),
      };
    }
  }
  return { transcript: [], unavailable: true };
}
