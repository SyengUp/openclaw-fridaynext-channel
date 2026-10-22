import {
  operationResult,
  writeOperation,
  type OpenClawOperationResult,
} from "../../adapters/openclaw/operation-result.js";
// POST /friday-next/questions/{questionId} — submit the app user's answer to a pending
// ask_user question.
//
// Body (single-question records):
//   { optionValue?: string }        — one declared option label (card button tap)
//   { text?: string }               — free-text answer (the always-on isOther custom path)
//   { values?: string[] }           — multi-select submission
// Body (multi-question records):
//   { answers?: { [innerQuestionId]: string[] } }
//
// The gateway's question.* methods require scope operator.questions, which plugin routes
// (auth:"plugin") do not carry — elevated in-place on the request scope first (same ALS
// pattern as agent/operator-scope.ts). answered / already-terminal are both HTTP 200 so an
// app retry after a race (expired mid-tap, answered on another surface) is not an error.
//
// GET /friday-next/questions/{questionId} — re-check a question's current state (status,
// expiresAtMs, questions, answers). The app uses it when re-showing a card after a reconnect
// to learn whether the question is still pending.

import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { readJsonBody } from "../middleware/body.js";
import { extractBearerToken } from "../middleware/auth.js";
import { getRuntimeV3Store } from "../../runtime-v3/runtime-store.js";
import { ensureGatewayRequestScopes } from "../../agent/operator-scope.js";
import { createFridayNextLogger } from "../../logging.js";
import { processMap } from "../../process-state.js";
import { toSessionStoreKey } from "../../session/session-manager.js";

const QUESTION_SCOPES = ["operator.questions"] as const;

/** Gateway error `details.reason` values that mean the question can no longer be answered. */
const TERMINAL_REASONS = new Set(["QUESTION_ALREADY_TERMINAL", "QUESTION_NOT_FOUND"]);

type GatewayErrorShape = {
  code?: string;
  message?: string;
  details?: unknown;
};

function errorReason(error: GatewayErrorShape | undefined): string | undefined {
  const details = error?.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}

type QuestionRecordQuestion = {
  questionId?: unknown;
  options?: unknown;
  multiSelect?: unknown;
};

type QuestionRecordView = {
  id?: unknown;
  sessionKey?: unknown;
  runId?: unknown;
  agentId?: unknown;
  status?: unknown;
  questions?: unknown;
  answers?: unknown;
  expiresAtMs?: unknown;
};

function readRecord(
  payload: unknown,
): { record: QuestionRecordView; questions: QuestionRecordQuestion[] } | undefined {
  const record = (payload as { question?: QuestionRecordView } | undefined)?.question;
  if (!record || typeof record !== "object") return undefined;
  const questions = Array.isArray(record.questions)
    ? (record.questions as QuestionRecordQuestion[])
    : [];
  return { record, questions };
}

export async function handleQuestionLookup(
  req: IncomingMessage,
  res: ServerResponse,
  questionIdRaw: string,
): Promise<boolean> {
  const json = (status: number, body: Record<string, unknown>) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
    return true;
  };
  if (req.method !== "GET") return json(405, { error: "Method Not Allowed" });
  if (!extractBearerToken(req)) return json(401, { error: "Unauthorized: bearer token mismatch" });
  const questionId = questionIdRaw.trim();
  if (!questionId) return json(400, { error: "Missing questionId" });

  ensureGatewayRequestScopes(QUESTION_SCOPES);
  const result = await dispatchGatewayMethod("question.get", { id: questionId });
  if (!result.ok) {
    const reason = errorReason(result.error);
    if (reason === "QUESTION_NOT_FOUND") {
      return json(200, { ok: true, questionId, status: "not-found" });
    }
    return json(502, { error: "Question lookup failed", detail: result.error?.message });
  }
  const found = readRecord(result.payload);
  if (!found) return json(502, { error: "Question lookup failed", detail: "missing record" });
  const expiresAtMs =
    typeof found.record.expiresAtMs === "number" ? found.record.expiresAtMs : undefined;
  return json(200, {
    ok: true,
    questionId,
    status: found.record.status,
    sessionKey: found.record.sessionKey,
    runId: found.record.runId,
    agentId: found.record.agentId,
    ...(found.record.status === "pending"
      ? { questions: found.record.questions, expiresAtMs }
      : {}),
    ...(found.record.answers ? { answers: found.record.answers } : {}),
  });
}

/** 重连和冷启动按当前会话重建待答快照；不用旧 SSE 是否仍可重放推测问题状态。 */
export async function handlePendingQuestions(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const reply = (status: number, body: Record<string, unknown>) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
    return true;
  };
  if (!extractBearerToken(req)) return reply(401, { error: "Unauthorized: bearer token mismatch" });
  const rawSession = new URL(req.url ?? "", "http://localhost").searchParams
    .get("sessionKey")
    ?.trim();
  if (!rawSession) return reply(400, { error: "Missing sessionKey" });
  const sessionKey = toSessionStoreKey(rawSession).toLowerCase();
  ensureGatewayRequestScopes(QUESTION_SCOPES);
  const result = await dispatchGatewayMethod("question.list", {});
  if (!result.ok)
    return reply(502, { error: "Question list failed", detail: result.error?.message });
  const rows = (result.payload as { questions?: unknown })?.questions;
  if (!Array.isArray(rows)) return reply(502, { error: "Question list is missing records" });
  const questions = rows
    .filter(
      (row: QuestionRecordView) =>
        row.status === "pending" &&
        typeof row.sessionKey === "string" &&
        toSessionStoreKey(row.sessionKey).toLowerCase() === sessionKey &&
        (typeof row.expiresAtMs !== "number" || row.expiresAtMs > Date.now()) &&
        Array.isArray(row.questions) &&
        !row.questions.some((question: { isSecret?: boolean }) => question.isSecret),
    )
    .map((row: QuestionRecordView) => ({ ...row, questionId: row.id }));
  return reply(200, { ok: true, questions });
}

export async function handleQuestionAnswer(
  req: IncomingMessage,
  res: ServerResponse,
  questionIdRaw: string,
): Promise<boolean> {
  if (req.method !== "POST")
    return writeOperation(res, operationResult(405, { error: "Method Not Allowed" }));
  if (!extractBearerToken(req))
    return writeOperation(
      res,
      operationResult(401, { error: "Unauthorized: bearer token mismatch" }),
    );
  return writeOperation(res, await submitOpenClawQuestion(questionIdRaw, await readJsonBody(req)));
}

export async function submitOpenClawQuestion(
  questionIdRaw: string,
  body: Record<string, unknown> | null,
): Promise<OpenClawOperationResult> {
  // 同一问题的答案与取消串行提交；不同问题互不阻塞，双模块加载也共享这个锁。
  const key = questionIdRaw.trim();
  const previous = questionSubmissions.get(key) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  questionSubmissions.set(key, pending);
  await previous.catch(() => undefined);
  try {
    return await handleQuestionAnswerSerial(body, questionIdRaw);
  } finally {
    release();
    if (questionSubmissions.get(key) === pending) questionSubmissions.delete(key);
  }
}

const questionSubmissions = processMap<string, Promise<void>>(
  Symbol.for("friday-next.question-submissions"),
);

async function handleQuestionAnswerSerial(
  body: Record<string, unknown> | null,
  questionIdRaw: string,
): Promise<OpenClawOperationResult> {
  const log = createFridayNextLogger("questions");
  const json = operationResult;
  const questionId = questionIdRaw.trim();
  if (!questionId) return json(400, { error: "Missing questionId" });

  if (!body) return json(400, { error: "Invalid JSON body" });
  if (body.cancel !== undefined && body.cancel !== true) {
    return json(400, { error: "cancel must be true" });
  }
  const cancel = body.cancel === true;

  const optionValue = typeof body.optionValue === "string" ? body.optionValue.trim() : "";
  const freeText = typeof body.text === "string" ? body.text.trim() : "";
  const values = Array.isArray(body.values)
    ? body.values.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
  const answersMap =
    body.answers && typeof body.answers === "object" && !Array.isArray(body.answers)
      ? (body.answers as Record<string, unknown>)
      : undefined;
  const shaped = [
    optionValue,
    freeText,
    values.length > 0 ? true : false,
    answersMap,
    cancel,
  ].filter((v) => v !== undefined && v !== false && v !== "").length;
  if (shaped === 0) {
    return json(400, { error: "Missing answer: optionValue, text, values, answers, or cancel" });
  }
  if (shaped > 1) {
    return json(400, { error: "Send exactly one of optionValue, text, values, answers, cancel" });
  }
  const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim().toUpperCase() : "";

  const receiptPayload = {
    ...(cancel ? { cancel: true } : {}),
    ...(optionValue ? { optionValue } : {}),
    ...(freeText ? { text: freeText } : {}),
    ...(values.length > 0 ? { values } : {}),
    ...(answersMap ? { answers: answersMap } : {}),
    deviceId,
  };
  const store = getRuntimeV3Store();
  const receiptStatus =
    store.commandReceipt("question", questionId)?.state === "succeeded"
      ? store.commandReceiptStatus("question", questionId, receiptPayload)
      : "missing";
  if (receiptStatus === "conflict") {
    return json(409, { error: "Question answer conflicts with the accepted answer" });
  }
  if (receiptStatus === "replayed") {
    return json(200, {
      ...(store.commandReceipt("question", questionId)?.response ?? {}),
      replayed: true,
    });
  }

  ensureGatewayRequestScopes(QUESTION_SCOPES);

  const fail = (status: number, error: string, detail?: unknown) => {
    const detailText =
      detail === undefined
        ? undefined
        : typeof detail === "string"
          ? detail
          : JSON.stringify(detail);
    log.warn(
      `question ${questionId} resolve failed: ${error}${detailText ? ` (${detailText})` : ""}`,
    );
    return json(status, detailText !== undefined ? { error, detail: detailText } : { error });
  };

  // Fetch the record first: the wire questionId (ask_*) is the RECORD id; answers key on the
  // inner per-question ids. Also gives us the pending gate + option validation up front.
  const getResult = await dispatchGatewayMethod("question.get", { id: questionId });
  if (!getResult.ok) {
    const reason = errorReason(getResult.error);
    if (reason === "QUESTION_NOT_FOUND") {
      return json(200, { ok: true, questionId, status: "already-terminal", reason: "not-found" });
    }
    return fail(502, "Question lookup failed", getResult.error?.message);
  }
  const found = readRecord(getResult.payload);
  if (!found) return fail(502, "Question lookup failed", "missing record");
  const { record, questions } = found;
  if (record.status !== "pending") {
    return json(200, {
      ok: true,
      questionId,
      status: "already-terminal",
      terminalStatus: record.status,
      ...(record.answers ? { answers: record.answers } : {}),
    });
  }
  let answers: Record<string, string[]> = {};
  if (!cancel) {
    if (questions.length === 0) return fail(502, "Question record carries no questions");

    const innerIds = questions.map((q) => (typeof q.questionId === "string" ? q.questionId : ""));
    if (innerIds.some((id) => !id))
      return fail(502, "Question record is missing an inner question id");

    if (answersMap) {
      // Multi-question / explicit mapping: every key must be a declared inner question id.
      const invalid = Object.keys(answersMap).filter((key) => !innerIds.includes(key));
      if (invalid.length > 0) {
        return fail(400, `answers reference undeclared question ids: ${invalid.join(", ")}`);
      }
      answers = Object.fromEntries(
        Object.entries(answersMap).map(([id, raw]) => [
          id,
          Array.isArray(raw)
            ? raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
            : [],
        ]),
      );
      if (Object.keys(answers).length === 0) {
        return json(400, { error: "answers must contain at least one non-empty value" });
      }
    } else {
      if (questions.length !== 1) {
        return fail(400, "Multi-question records require the answers map");
      }
      const innerId = innerIds[0];
      const question = questions[0];
      let answerValues: string[];
      if (values.length > 0) {
        answerValues = values;
      } else if (optionValue) {
        const declared = Array.isArray(question.options)
          ? question.options
              .map((o) =>
                o && typeof o === "object" && !Array.isArray(o)
                  ? ((o as { value?: unknown }).value ?? (o as { label?: unknown }).label)
                  : undefined,
              )
              .filter((l): l is string => typeof l === "string")
          : [];
        if (declared.length > 0 && !declared.includes(optionValue)) {
          return fail(400, `optionValue is not a declared option`, optionValue);
        }
        answerValues = [optionValue];
      } else {
        answerValues = [freeText];
      }
      answers = { [innerId]: answerValues };
    }
  }

  const resolveResult = await dispatchGatewayMethod("question.resolve", {
    id: questionId,
    ...(cancel ? { cancel: true } : { answers: { answers } }),
    ...(deviceId ? { resolvedBy: deviceId } : {}),
  });
  if (!resolveResult.ok) {
    const reason = errorReason(resolveResult.error);
    // Lost race against timeout / another surface: the answer can no longer land, which from
    // the app's perspective is a terminal card, not an error.
    if (reason && TERMINAL_REASONS.has(reason)) {
      return json(200, { ok: true, questionId, status: "already-terminal", reason });
    }
    return fail(502, "Question resolution failed", resolveResult.error?.message);
  }

  log.info(
    `question ${questionId} ${cancel ? "cancelled" : "answered"} by=${deviceId || "(none)"}`,
  );
  const response = {
    ok: true,
    questionId,
    status: cancel ? "cancelled" : "answered",
    ...(resolveResult.payload ? { result: resolveResult.payload } : {}),
  };
  store.completeAuthoritativeCommandReceipt("question", questionId, receiptPayload, response);
  return json(200, response);
}
