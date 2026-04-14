/**
 * Agent runner for the Friday channel.
 *
 * Wires SSE callbacks into the dispatch pipeline so that agent events
 * are forwarded to the appropriate device's SSE connection and
 * conversation history.
 */

import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { sseEmitter } from "../sse/emitter.js";
import { forwardAgentEventToFridaySse } from "../friday-session.js";
import {
  appendReasoning,
  endReasoning,
  appendAssistantBlock,
  appendFinalDelta,
  completeRound,
  errorRound,
} from "../conversation-history.js";

const log = (action: string, runId: string, detail?: string) => {
  const ts = new Date().toISOString();
  const detailPart = detail ? ` detail=${detail}` : "";
  console.error(`[Friday-RUNNER] [${ts}] [${action}] runId=${runId}${detailPart}`);
};

/**
 * Creates SSE-wired reply callbacks for a given sessionKey/runId.
 * These are passed to the dispatch pipeline via GetReplyOptions.
 *
 * Also updates conversation history as events arrive.
 */
export function createFridayReplyCallbacks(
  sessionKey: string,
  runId: string,
): Pick<GetReplyOptions, "onAgentEvent" | "onReasoningStream" | "onReasoningEnd" | "onPartialReply"> {
  let reasoningSeq = 0;
  let reasoningSegmentOpen = false;
  let lastReasoningText = "";

  const reasoningPayloadBase = (): Record<string, unknown> => ({ runId });

  return {
    onAgentEvent: (evt) => {
      forwardAgentEventToFridaySse({
        runId: evt.runId,
        seq: evt.seq,
        stream: evt.stream as string,
        data: evt.data as Record<string, unknown>,
        sessionKey: evt.sessionKey ?? sessionKey,
      });
    },

    onReasoningStream: (payload: ReplyPayload) => {
      const text = payload.text ?? "";
      const mediaUrls = payload.mediaUrls ?? [];

      if (!reasoningSegmentOpen && !text) return;

      if (!reasoningSegmentOpen) {
        sseEmitter.broadcastToRun(
          runId,
          {
            type: "reasoning",
            data: {
              ...reasoningPayloadBase(),
              phase: "start",
              seq: reasoningSeq,
              timestamp: Date.now(),
            },
          },
          true,
        );
        reasoningSegmentOpen = true;
        lastReasoningText = "";
      }

      if (text) {
        const delta = text.startsWith(lastReasoningText) ? text.slice(lastReasoningText.length) : text;
        lastReasoningText = text;
        if (delta) {
          sseEmitter.broadcastToRun(
            runId,
            {
              type: "reasoning",
              data: {
                ...reasoningPayloadBase(),
                phase: "delta",
                seq: reasoningSeq,
                text: delta,
                ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
              },
            },
            true,
          );
        }
      }

      log("REASONING_STREAM", runId, `textLen=${text.length} seq=${reasoningSeq}`);
      appendReasoning({ sessionKey, runId, reasoning: text });
    },

    onReasoningEnd: () => {
      log("REASONING_END", runId);
      if (reasoningSegmentOpen) {
        sseEmitter.broadcastToRun(
          runId,
          {
            type: "reasoning",
            data: {
              ...reasoningPayloadBase(),
              phase: "end",
              seq: reasoningSeq,
              timestamp: Date.now(),
            },
          },
          true,
        );
        reasoningSegmentOpen = false;
        lastReasoningText = "";
        reasoningSeq += 1;
      }
      endReasoning({ sessionKey, runId });
    },

    onPartialReply: (payload: ReplyPayload) => {
      const text = payload.text ?? "";
      if (!text) return;
      log("PARTIAL_REPLY", runId, `textLen=${text.length}`);
      sseEmitter.broadcastToRun(runId, {
        type: "final",
        data: { text, runId },
      });
      appendFinalDelta({ sessionKey, runId, text });
    },
  };
}

/**
 * Notify that a run has completed for a given sessionKey/runId.
 */
export function notifyRunComplete(sessionKey: string, runId: string): void {
  log("RUN_COMPLETE_BROADCAST", runId);
  // Signal final stream end before run-complete
  sseEmitter.broadcastToRun(runId, {
    type: "final",
    data: { done: true, runId },
  });
  sseEmitter.broadcastToRun(runId, {
    type: "run-complete",
    data: { runId },
  });
  // Delay untrackRun so the run-complete event has time to flush to the SSE socket.
  // conn.close() is called inside untrackRun, which would drop pending data otherwise.
  setImmediate(() => {
    sseEmitter.untrackRun(runId);
    completeRound({ sessionKey, runId });
  });
}

/**
 * Notify that a run has errored.
 */
export function notifyRunError(sessionKey: string, runId: string, error: string): void {
  log("RUN_ERROR_BROADCAST", runId, error);
  // Signal final stream end on error
  sseEmitter.broadcastToRun(runId, {
    type: "final",
    data: { done: true, runId },
  });
  sseEmitter.broadcastToRun(runId, {
    type: "run-error",
    data: { runId, error },
  });
  setImmediate(() => {
    sseEmitter.untrackRun(runId);
    errorRound({ sessionKey, runId, error });
  });
}
