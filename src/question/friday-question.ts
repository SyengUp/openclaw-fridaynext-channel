// Friday Next ask_user question bridge.
//
// OpenClaw's ask_user tool blocks the run and delivers the prompt through the reply
// dispatcher with channelData.askUser = { questionId, optionValues? }. This module:
//  1. tracks pending questions per session so the inbound serial queue lets a plain-text
//     ANSWER through to the core claim path (runReplyQuestionInput) instead of deadlocking
//     behind the run that is blocked waiting for that very answer;
//  2. registers a channel-delivery finalizer so the app learns the terminal state
//     (answered / expired / cancelled) over SSE — the core emits nothing deliver-shaped
//     on resolution, and the gateway's question.resolved broadcast is WS-only.

import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { sseEmitter } from "../sse/emitter.js";
import { toSessionStoreKey } from "../session/session-manager.js";
import { createFridayNextLogger } from "../logging.js";

const logger = createFridayNextLogger("question");

/**
 * Backstop retention for pending entries. The core's finalize callback is the real cleanup;
 * this only covers a gateway restart wiping the in-memory question runtime without callbacks
 * (max ask_user timeout is 3600s, so 70min covers any live question with margin).
 */
const PENDING_QUESTION_TTL_MS = 70 * 60 * 1_000;

export type FridayQuestionTerminalOp = "resolved" | "expired" | "cancelled";

export interface FridayQuestionTerminalPayload {
  op: FridayQuestionTerminalOp;
  questionId: string;
  /** Human-readable terminal line from the core ("Answered: X" | "Expired" | "Cancelled"). */
  statusLine: string;
  /** Chosen option labels when the core echoed declared choices back ("Answered: X"). */
  answeredLabels: string[];
  sessionKey: string;
  runId?: string;
  deviceId: string;
  ts: number;
}

type PendingFridayQuestion = {
  questionId: string;
  sessionKey: string;
  deviceId: string;
  runId?: string;
  createdAtMs: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
};

const pendingBySessionKey = new Map<string, PendingFridayQuestion>();
const sessionKeyByQuestionId = new Map<string, string>();

function dropPending(entry: PendingFridayQuestion): void {
  clearTimeout(entry.cleanupTimer);
  if (pendingBySessionKey.get(entry.sessionKey) === entry) {
    pendingBySessionKey.delete(entry.sessionKey);
  }
  if (sessionKeyByQuestionId.get(entry.questionId) === entry.sessionKey) {
    sessionKeyByQuestionId.delete(entry.questionId);
  }
}

/** Maps the core's terminal status line ("Answered: X" | "Expired" | "Cancelled"). */
export function terminalOpFromStatusLine(statusLine: string): {
  op: FridayQuestionTerminalOp;
  answeredLabels: string[];
} {
  const trimmed = statusLine.trim();
  if (trimmed === "Expired") return { op: "expired", answeredLabels: [] };
  if (trimmed === "Cancelled") return { op: "cancelled", answeredLabels: [] };
  if (trimmed === "Answered") return { op: "resolved", answeredLabels: [] };
  const prefix = "Answered: ";
  if (trimmed.startsWith(prefix)) {
    return {
      op: "resolved",
      answeredLabels: trimmed
        .slice(prefix.length)
        .split(",")
        .map((label) => label.trim())
        .filter(Boolean),
    };
  }
  // Unknown terminal phrasing still terminates the prompt; treat as resolved.
  return { op: "resolved", answeredLabels: [] };
}

/**
 * Records one delivered ask_user prompt as the session's pending question and registers the
 * terminal finalize bridge. Idempotent per questionId; a new question supersedes the
 * session's previous entry (the core enforces one pending question per session).
 */
export function noteFridayQuestionPrompt(params: {
  questionId: string;
  sessionKey: string;
  deviceId: string;
  runId?: string;
}): void {
  const questionId = params.questionId.trim();
  const rawSessionKey = params.sessionKey.trim();
  const deviceId = params.deviceId.trim().toUpperCase();
  // toSessionStoreKey maps "" onto the agent main key — reject empty input before canonicalizing.
  if (!questionId || !rawSessionKey || !deviceId) return;
  const sessionKey = toSessionStoreKey(rawSessionKey);
  if (sessionKeyByQuestionId.has(questionId)) return;

  const existing = pendingBySessionKey.get(sessionKey);
  if (existing) dropPending(existing);

  const entry: PendingFridayQuestion = {
    questionId,
    sessionKey,
    deviceId,
    runId: params.runId?.trim() || undefined,
    createdAtMs: Date.now(),
    cleanupTimer: setTimeout(() => {
      const current = pendingBySessionKey.get(sessionKey);
      if (current && current.questionId === questionId) dropPending(current);
    }, PENDING_QUESTION_TTL_MS),
  };
  entry.cleanupTimer.unref?.();
  pendingBySessionKey.set(sessionKey, entry);
  sessionKeyByQuestionId.set(questionId, sessionKey);

  questionGatewayRuntime.registerChannelDelivery({
    questionId,
    deliveryId: `friday-next:${deviceId}:${questionId}`,
    finalize: (statusLine) => {
      const tracked = pendingBySessionKey.get(sessionKey);
      if (tracked && tracked.questionId === questionId) dropPending(tracked);
      const { op, answeredLabels } = terminalOpFromStatusLine(statusLine);
      const payload: FridayQuestionTerminalPayload = {
        op,
        questionId,
        statusLine,
        answeredLabels,
        sessionKey,
        ...(entry.runId ? { runId: entry.runId } : {}),
        deviceId,
        ts: Date.now(),
      };
      logger.info(`question ${questionId} terminal op=${op} session=${sessionKey}`);
      // runId rides along so the event mirrors into the durable runtime-v3 journal
      // (the app only listens there); the question terminalizes while its run is still
      // blocked in waitAnswer, so the append lands before run completion.
      sseEmitter.broadcast({ type: "question", data: { ...payload } }, deviceId, true);
    },
  });
}

/** True while the session has an unanswered ask_user question (its run is blocked on it). */
export function hasPendingFridayQuestion(sessionKey: string): boolean {
  const raw = sessionKey.trim();
  if (!raw) return false;
  return pendingBySessionKey.has(toSessionStoreKey(raw));
}

/** Reads the ask_user correlation data off a delivered reply payload, if present. */
export function readFridayAskUserBinding(payload: unknown): { questionId: string } | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const channelData = (payload as { channelData?: unknown }).channelData;
  if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) {
    return undefined;
  }
  const askUser = (channelData as { askUser?: unknown }).askUser;
  if (!askUser || typeof askUser !== "object" || Array.isArray(askUser)) return undefined;
  const questionId = (askUser as { questionId?: unknown }).questionId;
  return typeof questionId === "string" && questionId.trim() ? { questionId } : undefined;
}

/** Vitest: drop all pending state (timers included). */
export function __resetFridayQuestionsForTest(): void {
  for (const entry of pendingBySessionKey.values()) clearTimeout(entry.cleanupTimer);
  pendingBySessionKey.clear();
  sessionKeyByQuestionId.clear();
}
