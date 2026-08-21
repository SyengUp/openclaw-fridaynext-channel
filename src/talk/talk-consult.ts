/**
 * Gateway-relay Talk consult handshake.
 *
 * Realtime providers only expose `openclaw_agent_consult` (and optional control).
 * The browser Control UI starts `talk.client.toolCall`, waits for the chat run,
 * then `talk.session.submitToolResult`. Friday has no operator WebSocket, so the
 * plugin HTTP route performs that handshake on the synthetic talk connId.
 */

import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { normalizeHistoryMessages } from "../history/normalize-message.js";
import { readSessionTranscriptRawMessages } from "../history/read-transcript.js";
import { getFridayNextRuntime } from "../runtime.js";
import { createFridayNextLogger } from "../logging.js";
import { asRecord } from "./talk-session-bridge.js";

export const REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME = "openclaw_agent_consult";
export const REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME = "openclaw_agent_control";

export const TALK_CONSULT_TIMEOUT_MS = 120_000;
const FALLBACK_SESSION_KEY = "agent:main:fridaynext-talk";

const WORKING_CONSULT_RESULT = {
  status: "working",
  tool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  message:
    "Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.",
};

const logger = createFridayNextLogger("talk-consult");

export type TalkConsultDispatch = (
  method: string,
  params: Record<string, unknown>,
) => Promise<{
  ok: boolean;
  payload: Record<string, unknown>;
  error?: string;
  code?: string;
  details?: unknown;
}>;

export type TalkConsultLoadAssistantText = (sessionKey: string) => Promise<string | null>;

export type TalkConsultRequest = {
  sessionId: string;
  sessionKey?: string;
  callId: string;
  name: string;
  args?: unknown;
  forced?: boolean;
  dispatch?: TalkConsultDispatch;
  loadAssistantText?: TalkConsultLoadAssistantText;
};

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

export function resolveTalkConsultSessionKey(
  stored: string | undefined,
  requested: string | undefined,
): string {
  return optionalNonEmptyString(requested) ?? optionalNonEmptyString(stored) ?? FALLBACK_SESSION_KEY;
}

export async function defaultTalkConsultDispatch(
  method: string,
  params: Record<string, unknown>,
): Promise<{
  ok: boolean;
  payload: Record<string, unknown>;
  error?: string;
  code?: string;
  details?: unknown;
}> {
  let response: Awaited<ReturnType<typeof dispatchGatewayMethod>>;
  try {
    response = await dispatchGatewayMethod(method, params);
  } catch (err) {
    return {
      ok: false,
      payload: {},
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      payload: payloadRecord(response.payload),
      error: response.error?.message ?? `${method} failed`,
      code: response.error?.code,
      details: (response.error as { details?: unknown } | undefined)?.details,
    };
  }
  return { ok: true, payload: payloadRecord(response.payload) };
}

function assistantTextFromMessages(raw: unknown[]): string | null {
  const normalized = normalizeHistoryMessages(raw);
  for (let i = normalized.length - 1; i >= 0; i -= 1) {
    const entry = normalized[i];
    if (entry.role !== "assistant") continue;
    const text = optionalNonEmptyString(entry.text);
    if (text) return text;
  }
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const record = asRecord(raw[i]);
    if (!record) continue;
    const role = optionalNonEmptyString(record.role)?.toLowerCase();
    if (role && role !== "assistant") continue;
    const text =
      optionalNonEmptyString(record.text) ??
      optionalNonEmptyString(record.content) ??
      optionalNonEmptyString(asRecord(record.content)?.text);
    if (text) return text;
  }
  return null;
}

/**
 * OpenClaw's canonical consult result is `{ text }`. `result` is kept as an alias
 * because older speakable-result readers look at `text` then `result`.
 */
function speakableConsultResult(text: string): { text: string; result: string } {
  return { text, result: text };
}

function terminalReplyText(payload: Record<string, unknown>): string | undefined {
  const reply = asRecord(payload.terminalReply);
  if (!reply) return optionalNonEmptyString(payload.replyText);
  const disposition = optionalNonEmptyString(reply.disposition)?.toLowerCase();
  if (disposition === "silent" || disposition === "empty") return undefined;
  return optionalNonEmptyString(reply.text);
}

function isCompletedWaitError(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "completed" || normalized === "ok" || normalized === "succeeded";
}

export async function loadTalkConsultAssistantText(sessionKey: string): Promise<string | null> {
  // Disk first: `getSessionMessages` dispatches `sessions.get`, which is empty
  // from a plugin HTTP route unless a gateway request scope is attached.
  try {
    const fromDisk = assistantTextFromMessages(readSessionTranscriptRawMessages(sessionKey, 40));
    if (fromDisk) return fromDisk;
  } catch (err) {
    logger.warn(
      `consult transcript file read failed session=${sessionKey} error=${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const runtime = getFridayNextRuntime() as {
      subagent?: {
        getSessionMessages?: (params: {
          sessionKey: string;
          limit?: number;
        }) => Promise<{ messages?: unknown[] }>;
      };
    };
    const messages = await runtime.subagent?.getSessionMessages?.({ sessionKey, limit: 40 });
    return assistantTextFromMessages(Array.isArray(messages?.messages) ? messages.messages : []);
  } catch (err) {
    logger.warn(
      `consult transcript read failed session=${sessionKey} error=${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return null;
}

async function resolveConsultSpeakableText(
  payload: Record<string, unknown>,
  sessionKey: string,
  loader: TalkConsultLoadAssistantText,
): Promise<string | undefined> {
  const fromWait = terminalReplyText(payload);
  if (fromWait) return fromWait;
  const fromSession = optionalNonEmptyString(await loader(sessionKey));
  return fromSession;
}

function parseControlArgs(args: unknown): { text: string; mode?: string } | { error: string } {
  const record = asRecord(args) ?? {};
  const text = optionalNonEmptyString(record.text);
  if (!text) return { error: "openclaw_agent_control requires text" };
  const mode = optionalNonEmptyString(record.mode);
  return mode ? { text, mode } : { text };
}

function waitStatus(payload: Record<string, unknown>, rpcError?: string): string {
  if (isCompletedWaitError(rpcError)) return "ok";
  const status = optionalNonEmptyString(payload.status)?.toLowerCase();
  if (status === "completed" || status === "succeeded") return "ok";
  if (status === "error" && isCompletedWaitError(optionalNonEmptyString(payload.error))) {
    return "ok";
  }
  return status ?? (rpcError ? "error" : "ok");
}

async function submitToolResult(
  dispatch: TalkConsultDispatch,
  sessionId: string,
  callId: string,
  result: unknown,
  options?: { willContinue?: boolean; suppressResponse?: boolean },
): Promise<void> {
  const params: Record<string, unknown> = { sessionId, callId, result };
  if (options) params.options = options;
  const submitted = await dispatch("talk.session.submitToolResult", params);
  if (!submitted.ok) {
    logger.warn(
      `submitToolResult failed session=${sessionId} callId=${callId} error=${submitted.error ?? "unknown"}`,
    );
  }
}

/**
 * Runs one realtime tool call to completion and feeds the provider the result.
 */
export async function completeTalkRelayToolCall(
  request: TalkConsultRequest,
): Promise<{ ok: boolean; runId?: string; error?: string; code?: string }> {
  const dispatch = request.dispatch ?? defaultTalkConsultDispatch;
  const sessionId = optionalNonEmptyString(request.sessionId);
  const callId = optionalNonEmptyString(request.callId);
  const name = optionalNonEmptyString(request.name);
  if (!sessionId || !callId || !name) {
    return { ok: false, error: "talk.session.toolCall requires sessionId, callId, and name", code: "INVALID_REQUEST" };
  }

  const sessionKey = resolveTalkConsultSessionKey(undefined, request.sessionKey);

  if (name === REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME) {
    const parsed = parseControlArgs(request.args);
    if ("error" in parsed) {
      await submitToolResult(dispatch, sessionId, callId, { error: parsed.error });
      return { ok: false, error: parsed.error, code: "INVALID_REQUEST" };
    }
    const steerParams: Record<string, unknown> = {
      sessionId,
      sessionKey,
      text: parsed.text,
    };
    if (parsed.mode) steerParams.mode = parsed.mode;
    const steered = await dispatch("talk.session.steer", steerParams);
    await submitToolResult(
      dispatch,
      sessionId,
      callId,
      steered.ok ? steered.payload : { error: steered.error ?? "talk.session.steer failed" },
    );
    return steered.ok
      ? { ok: true }
      : { ok: false, error: steered.error, code: steered.code };
  }

  if (name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
    await submitToolResult(dispatch, sessionId, callId, {
      error: `Tool "${name}" is not available in Friday Talk`,
    });
    return { ok: false, error: `unsupported realtime Talk tool: ${name}`, code: "INVALID_REQUEST" };
  }

  if (request.forced) {
    await submitToolResult(dispatch, sessionId, callId, WORKING_CONSULT_RESULT, { willContinue: true });
  }

  const started = await dispatch("talk.client.toolCall", {
    sessionKey,
    callId,
    name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
    args: request.args ?? {},
    relaySessionId: sessionId,
  });
  if (!started.ok) {
    await submitToolResult(dispatch, sessionId, callId, {
      error: started.error ?? "talk.client.toolCall failed",
    });
    return { ok: false, error: started.error, code: started.code };
  }

  const runId =
    optionalNonEmptyString(started.payload.runId) ??
    optionalNonEmptyString(started.payload.idempotencyKey);
  if (!runId) {
    await submitToolResult(dispatch, sessionId, callId, {
      error: "OpenClaw realtime tool call did not return a run id",
    });
    return { ok: false, error: "OpenClaw realtime tool call did not return a run id" };
  }

  const waited = await dispatch("agent.wait", {
    runId,
    timeoutMs: TALK_CONSULT_TIMEOUT_MS,
  });
  const waitPayload = waited.payload ?? {};
  const status = waitStatus(waitPayload, waited.ok ? undefined : waited.error);
  const loader = request.loadAssistantText ?? loadTalkConsultAssistantText;
  const text = await resolveConsultSpeakableText(waitPayload, sessionKey, loader);

  // Chat SSE can already show a successful reply (weather, etc.) while
  // `agent.wait` reports a tool/lifecycle error or the known `{ error: "completed" }`
  // envelope. Prefer the session's speakable text over a voice-side failure.
  if (text) {
    await submitToolResult(dispatch, sessionId, callId, speakableConsultResult(text));
    logger.info(`consult complete session=${sessionId} runId=${runId} chars=${text.length}`);
    return { ok: true, runId };
  }

  if (status === "timeout") {
    await submitToolResult(dispatch, sessionId, callId, { error: "OpenClaw tool call timed out" });
    return { ok: false, runId, error: "OpenClaw tool call timed out", code: "UNAVAILABLE" };
  }
  if (!waited.ok || status === "error" || status === "aborted") {
    const message =
      optionalNonEmptyString(waitPayload.error) ??
      optionalNonEmptyString(waitPayload.errorMessage) ??
      waited.error ??
      "OpenClaw tool call failed";
    await submitToolResult(dispatch, sessionId, callId, { error: message });
    return { ok: false, runId, error: message, code: waited.code };
  }

  await submitToolResult(dispatch, sessionId, callId, speakableConsultResult("OpenClaw finished with no text."));
  logger.info(`consult complete session=${sessionId} runId=${runId} chars=0`);
  return { ok: true, runId };
}
