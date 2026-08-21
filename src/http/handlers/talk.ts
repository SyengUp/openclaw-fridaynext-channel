/**
 * Talk mode admin surface for the app.
 *
 *   GET  /friday-next-admin/talk/catalog  → `talk.catalog`
 *   GET  /friday-next-admin/talk/config   → `talk.config` (never includeSecrets)
 *   POST /friday-next-admin/talk/speak    → `talk.speak`
 *   POST /friday-next-admin/talk/mode     → `talk.mode`
 *   POST /friday-next-admin/talk/session         → `talk.session.create` (or runtime.talk.openSession)
 *   POST /friday-next-admin/talk/session/audio   → `talk.session.appendAudio`
 *   POST /friday-next-admin/talk/session/tool-call → `talk.client.toolCall` + wait + `submitToolResult`
 *   POST /friday-next-admin/talk/session/cancel  → `talk.session.cancelOutput`
 *   POST /friday-next-admin/talk/session/close   → `talk.session.close`
 *
 * WHY THE `/friday-next-admin` SIBLING PREFIX (not `/friday-next`):
 * `/friday-next` is registered `auth: "plugin"`, and core gives plugin-authed routes a
 * runtime client with an EMPTY operator scope list, so dispatching any scoped method
 * from there is refused. A gateway-authed route cannot overlap that prefix, so these
 * live next door — same reasoning as `commands-list.ts` / `cron.ts`.
 *
 * SCOPES (src/gateway/methods/core-descriptors.ts):
 *   `talk.catalog` / `talk.config`  → operator.read
 *   `talk.speak` / `talk.mode` / `talk.session.*` → operator.write
 * None of these need `operator.admin`, so this prefix does NOT set
 * `gatewayRuntimeScopeSurface: "trusted-operator"`. The default surface's
 * `operator.write` already satisfies both.
 *
 * `talk.config` with `includeSecrets: true` requires `operator.talk.secrets`.
 * This route never forwards that flag — credentials stay on the Gateway.
 *
 * Dispatch requires the manifest's `contracts.gatewayMethodDispatch:
 * ["authenticated-request"]` (already declared).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { isPublicRequest } from "../middleware/public-surface.js";
import { readJsonBody } from "../middleware/body.js";
import { verifySession } from "../../attest/attest-store.js";
import { attestGateDecision, ATTEST_REJECTION_BODY } from "../../attest/attest-gate.js";
import { resolveFridayNextConfig } from "../../config.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { getFridayNextRuntime } from "../../runtime.js";
import { getTalkOpenSession } from "../../talk/talk-runtime.js";
import { registerFridaySessionDeviceMapping } from "../../friday-session.js";
import {
  completeTalkRelayToolCall,
  resolveTalkConsultSessionKey,
} from "../../talk/talk-consult.js";
import {
  asRecord,
  attachTalkOwnerConnId,
  emitSdkTalkEvent,
  forgetTalkSession,
  lookupTalkSession,
  mintTalkOwnerConnId,
  rememberTalkSession,
} from "../../talk/talk-session-bridge.js";

const CATALOG_PATH = "/friday-next-admin/talk/catalog";
const CONFIG_PATH = "/friday-next-admin/talk/config";
const SPEAK_PATH = "/friday-next-admin/talk/speak";
const MODE_PATH = "/friday-next-admin/talk/mode";
const SESSION_PATH = "/friday-next-admin/talk/session";
const SESSION_AUDIO_PATH = "/friday-next-admin/talk/session/audio";
const SESSION_TOOL_CALL_PATH = "/friday-next-admin/talk/session/tool-call";
const SESSION_CANCEL_PATH = "/friday-next-admin/talk/session/cancel";
const SESSION_CLOSE_PATH = "/friday-next-admin/talk/session/close";

const TALK_PATHS = new Set([
  CATALOG_PATH,
  CONFIG_PATH,
  SPEAK_PATH,
  MODE_PATH,
  SESSION_PATH,
  SESSION_AUDIO_PATH,
  SESSION_TOOL_CALL_PATH,
  SESSION_CANCEL_PATH,
  SESSION_CLOSE_PATH,
]);

function json(res: ServerResponse, status: number, body: Record<string, unknown>): true {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
  return true;
}

function statusForErrorCode(code: string | undefined): number {
  switch (code) {
    case "INVALID_REQUEST":
      return 400;
    case "NOT_LINKED":
    case "NOT_PAIRED":
      return 409;
    case "UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

function attestRejects(req: IncomingMessage, pathname: string): boolean {
  if (!isPublicRequest(req)) return false;
  const attestCfg = resolveFridayNextConfig(
    getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
  );
  return (
    attestGateDecision({
      pathname,
      headers: req.headers,
      isPublic: true,
      required: attestCfg.appAttest.required,
      scope: "plugin",
      verify: (t) => verifySession(t, Date.now()),
    }) === "reject"
  );
}

function errorEnvelope(
  response: Awaited<ReturnType<typeof dispatchGatewayMethod>>,
  fallbackMessage: string,
): Record<string, unknown> {
  const code = response.error?.code;
  const details = (response.error as { details?: unknown } | undefined)?.details;
  return {
    ok: false,
    error: response.error?.message ?? fallbackMessage,
    ...(code ? { code } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

async function dispatchTalk(
  res: ServerResponse,
  method: string,
  params: Record<string, unknown>,
): Promise<true> {
  let response: Awaited<ReturnType<typeof dispatchGatewayMethod>>;
  try {
    response = await dispatchGatewayMethod(method, params);
  } catch (err) {
    return json(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!response.ok) {
    return json(res, statusForErrorCode(response.error?.code), errorEnvelope(response, `${method} failed`));
  }
  const payload = (response.payload ?? {}) as Record<string, unknown>;
  return json(res, 200, { ok: true, ...payload });
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// consult 不走 POST /messages。不把 sessionKey 登记到设备的话，
// `forwardAgentEventRaw` 解析不到 Friday device，工具窗 SSE 会在进 app 之前被丢掉。
function bindConsultSessionToDevice(sessionKey: string | undefined, deviceId: string): void {
  const key = optionalNonEmptyString(sessionKey);
  if (!key) return;
  registerFridaySessionDeviceMapping(key, deviceId);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalInteger(value: unknown, minimum: number): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) return undefined;
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Whitelist of `talk.speak` params the app is allowed to forward. */
function speakParamsFromBody(body: Record<string, unknown>): Record<string, unknown> | { error: string } {
  const text = optionalNonEmptyString(body.text);
  if (!text) return { error: "talk.speak requires text" };

  const params: Record<string, unknown> = { text };
  const voiceId = optionalNonEmptyString(body.voiceId);
  if (voiceId) params.voiceId = voiceId;
  const modelId = optionalNonEmptyString(body.modelId);
  if (modelId) params.modelId = modelId;
  const outputFormat = optionalNonEmptyString(body.outputFormat);
  if (outputFormat) params.outputFormat = outputFormat;
  const speed = optionalNumber(body.speed);
  if (speed !== undefined) params.speed = speed;
  const rateWpm = optionalInteger(body.rateWpm, 1);
  if (rateWpm !== undefined) params.rateWpm = rateWpm;
  const stability = optionalNumber(body.stability);
  if (stability !== undefined) params.stability = stability;
  const similarity = optionalNumber(body.similarity);
  if (similarity !== undefined) params.similarity = similarity;
  const style = optionalNumber(body.style);
  if (style !== undefined) params.style = style;
  const speakerBoost = optionalBoolean(body.speakerBoost);
  if (speakerBoost !== undefined) params.speakerBoost = speakerBoost;
  const seed = optionalInteger(body.seed, 0);
  if (seed !== undefined) params.seed = seed;
  const normalize = optionalNonEmptyString(body.normalize);
  if (normalize) params.normalize = normalize;
  const language = optionalNonEmptyString(body.language);
  if (language) params.language = language;
  const latencyTier = optionalInteger(body.latencyTier, 0);
  if (latencyTier !== undefined) params.latencyTier = latencyTier;
  return params;
}

/**
 * Prefix handler for `/friday-next-admin/talk/*`.
 * Returns false when the pathname is not a Talk route so other prefix matches
 * (none today) can keep looking.
 */
export async function handleTalk(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (!TALK_PATHS.has(pathname)) {
    return false;
  }

  if (attestRejects(req, pathname)) {
    return json(res, 403, { ...ATTEST_REJECTION_BODY });
  }

  if (pathname === CATALOG_PATH) {
    if (req.method !== "GET") return json(res, 405, { error: "Method Not Allowed" });
    return await dispatchTalk(res, "talk.catalog", {});
  }

  if (pathname === CONFIG_PATH) {
    if (req.method !== "GET") return json(res, 405, { error: "Method Not Allowed" });
    // Never forward includeSecrets — Talk credentials stay on the Gateway.
    return await dispatchTalk(res, "talk.config", {});
  }

  if (pathname === SPEAK_PATH) {
    if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });
    const body = await readJsonBody(req);
    if (!body) return json(res, 400, { ok: false, error: "invalid JSON body" });
    const params = speakParamsFromBody(body);
    if ("error" in params) return json(res, 400, { ok: false, error: params.error });
    return await dispatchTalk(res, "talk.speak", params);
  }

  if (pathname === MODE_PATH) {
    if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });
    const modeBody = await readJsonBody(req);
    if (!modeBody) return json(res, 400, { ok: false, error: "invalid JSON body" });
    if (typeof modeBody.enabled !== "boolean") {
      return json(res, 400, { ok: false, error: "talk.mode requires enabled: boolean" });
    }
    const modeParams: Record<string, unknown> = { enabled: modeBody.enabled };
    const phase = optionalNonEmptyString(modeBody.phase);
    if (phase) modeParams.phase = phase;
    return await dispatchTalk(res, "talk.mode", modeParams);
  }

  if (pathname === SESSION_PATH) {
    if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });
    return await handleTalkSessionCreate(res, await readJsonBody(req));
  }
  if (pathname === SESSION_AUDIO_PATH) {
    if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });
    return await handleTalkSessionAudio(res, await readJsonBody(req));
  }
  if (pathname === SESSION_TOOL_CALL_PATH) {
    if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });
    return await handleTalkSessionToolCall(res, await readJsonBody(req));
  }
  if (pathname === SESSION_CANCEL_PATH) {
    if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });
    return await handleTalkSessionCancel(res, await readJsonBody(req));
  }
  if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });
  return await handleTalkSessionClose(res, await readJsonBody(req));
}

async function handleTalkSessionCreate(
  res: ServerResponse,
  body: Record<string, unknown> | null,
): Promise<true> {
  if (!body) return json(res, 400, { ok: false, error: "invalid JSON body" });
  const deviceId = optionalNonEmptyString(body.deviceId);
  if (!deviceId) return json(res, 400, { ok: false, error: "talk.session requires deviceId" });

  const sessionKey = optionalNonEmptyString(body.sessionKey);
  const openSession = getTalkOpenSession();
  if (openSession) {
    try {
      const handle = await openSession({
        ...(sessionKey ? { sessionKey } : {}),
        onEvent: (event) => {
          const payload = asRecord(event) ?? { type: "unknown" };
          emitSdkTalkEvent(deviceId, payload);
        },
      });
      const sessionId =
        (typeof handle.sessionId === "string" && handle.sessionId.trim()) ||
        `sdk:${crypto.randomUUID()}`;
      rememberTalkSession(sessionId, { kind: "sdk", deviceId, sessionKey, handle });
      bindConsultSessionToDevice(sessionKey, deviceId);
      return json(res, 200, {
        ok: true,
        sessionId,
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        via: "sdk",
      });
    } catch (err) {
      return json(res, 503, {
        ok: false,
        code: "UNAVAILABLE",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const connId = mintTalkOwnerConnId(deviceId);
  if (!attachTalkOwnerConnId(connId)) {
    return json(res, 503, {
      ok: false,
      code: "UNAVAILABLE",
      error: "Talk session unavailable (no gateway request scope)",
    });
  }

  const params: Record<string, unknown> = {
    mode: optionalNonEmptyString(body.mode) ?? "realtime",
    transport: optionalNonEmptyString(body.transport) ?? "gateway-relay",
    brain: optionalNonEmptyString(body.brain) ?? "agent-consult",
  };
  if (sessionKey) params.sessionKey = sessionKey;
  const provider = optionalNonEmptyString(body.provider);
  if (provider) params.provider = provider;
  const model = optionalNonEmptyString(body.model);
  if (model) params.model = model;
  const voice = optionalNonEmptyString(body.voice);
  if (voice) params.voice = voice;

  const created = await dispatchTalkPayload("talk.session.create", params);
  if (!created.ok) {
    return json(res, statusForErrorCode(created.code), {
      ok: false,
      error: created.error,
      ...(created.code ? { code: created.code } : {}),
      ...(created.details !== undefined ? { details: created.details } : {}),
    });
  }
  const sessionId =
    optionalNonEmptyString(created.payload.sessionId) ??
    optionalNonEmptyString(created.payload.relaySessionId);
  if (!sessionId) {
    return json(res, 503, {
      ok: false,
      code: "UNAVAILABLE",
      error: "Talk session create returned no sessionId",
    });
  }
  rememberTalkSession(sessionId, { kind: "dispatch", deviceId, connId, sessionKey });
  bindConsultSessionToDevice(sessionKey, deviceId);
  return json(res, 200, { ok: true, ...created.payload, sessionId });
}

async function handleTalkSessionAudio(
  res: ServerResponse,
  body: Record<string, unknown> | null,
): Promise<true> {
  if (!body) return json(res, 400, { ok: false, error: "invalid JSON body" });
  const sessionId = optionalNonEmptyString(body.sessionId);
  const audioBase64 = optionalNonEmptyString(body.audioBase64);
  if (!sessionId) return json(res, 400, { ok: false, error: "talk.session.appendAudio requires sessionId" });
  if (!audioBase64) return json(res, 400, { ok: false, error: "talk.session.appendAudio requires audioBase64" });

  const entry = lookupTalkSession(sessionId);
  if (!entry) return json(res, 404, { ok: false, error: "unknown talk session" });

  if (entry.kind === "sdk") {
    try {
      await entry.handle?.sendAudio(Buffer.from(audioBase64, "base64"));
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!entry.connId || !attachTalkOwnerConnId(entry.connId)) {
    return json(res, 503, {
      ok: false,
      code: "UNAVAILABLE",
      error: "Talk session unavailable (no gateway request scope)",
    });
  }
  const params: Record<string, unknown> = { sessionId, audioBase64 };
  const timestamp = optionalNumber(body.timestamp);
  if (timestamp !== undefined) params.timestamp = timestamp;
  return await dispatchTalk(res, "talk.session.appendAudio", params);
}

async function handleTalkSessionToolCall(
  res: ServerResponse,
  body: Record<string, unknown> | null,
): Promise<true> {
  if (!body) return json(res, 400, { ok: false, error: "invalid JSON body" });
  const sessionId = optionalNonEmptyString(body.sessionId);
  const callId = optionalNonEmptyString(body.callId);
  const name = optionalNonEmptyString(body.name);
  if (!sessionId) return json(res, 400, { ok: false, error: "talk.session.toolCall requires sessionId" });
  if (!callId) return json(res, 400, { ok: false, error: "talk.session.toolCall requires callId" });
  if (!name) return json(res, 400, { ok: false, error: "talk.session.toolCall requires name" });

  const entry = lookupTalkSession(sessionId);
  if (!entry) return json(res, 404, { ok: false, error: "unknown talk session" });
  if (entry.kind === "sdk") {
    return json(res, 400, {
      ok: false,
      error: "SDK Talk sessions do not support client tool-call relay",
    });
  }
  if (!entry.connId || !attachTalkOwnerConnId(entry.connId)) {
    return json(res, 503, {
      ok: false,
      code: "UNAVAILABLE",
      error: "Talk session unavailable (no gateway request scope)",
    });
  }

  const sessionKey = resolveTalkConsultSessionKey(
    entry.sessionKey,
    optionalNonEmptyString(body.sessionKey),
  );
  bindConsultSessionToDevice(sessionKey, entry.deviceId);
  rememberTalkSession(sessionId, { ...entry, sessionKey });

  const result = await completeTalkRelayToolCall({
    sessionId,
    callId,
    name,
    args: body.args,
    forced: body.forced === true,
    sessionKey,
    dispatch: dispatchTalkPayload,
  });
  if (!result.ok) {
    return json(res, statusForErrorCode(result.code), {
      ok: false,
      error: result.error ?? "talk.session.toolCall failed",
      ...(result.code ? { code: result.code } : {}),
      ...(result.runId ? { runId: result.runId } : {}),
    });
  }
  return json(res, 200, {
    ok: true,
    ...(result.runId ? { runId: result.runId } : {}),
  });
}

async function handleTalkSessionCancel(
  res: ServerResponse,
  body: Record<string, unknown> | null,
): Promise<true> {
  if (!body) return json(res, 400, { ok: false, error: "invalid JSON body" });
  const sessionId = optionalNonEmptyString(body.sessionId);
  if (!sessionId) return json(res, 400, { ok: false, error: "talk.session.cancelOutput requires sessionId" });
  const entry = lookupTalkSession(sessionId);
  if (!entry) return json(res, 404, { ok: false, error: "unknown talk session" });
  const reason = optionalNonEmptyString(body.reason);

  if (entry.kind === "sdk") {
    try {
      await entry.handle?.cancelOutput?.(reason ?? "output-cancelled");
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!entry.connId || !attachTalkOwnerConnId(entry.connId)) {
    return json(res, 503, {
      ok: false,
      code: "UNAVAILABLE",
      error: "Talk session unavailable (no gateway request scope)",
    });
  }
  const params: Record<string, unknown> = { sessionId };
  if (reason) params.reason = reason;
  return await dispatchTalk(res, "talk.session.cancelOutput", params);
}

async function handleTalkSessionClose(
  res: ServerResponse,
  body: Record<string, unknown> | null,
): Promise<true> {
  if (!body) return json(res, 400, { ok: false, error: "invalid JSON body" });
  const sessionId = optionalNonEmptyString(body.sessionId);
  if (!sessionId) return json(res, 400, { ok: false, error: "talk.session.close requires sessionId" });
  const entry = lookupTalkSession(sessionId);
  if (!entry) return json(res, 404, { ok: false, error: "unknown talk session" });

  try {
    if (entry.kind === "sdk") {
      await entry.handle?.close();
      forgetTalkSession(sessionId);
      return json(res, 200, { ok: true });
    }
    if (!entry.connId || !attachTalkOwnerConnId(entry.connId)) {
      forgetTalkSession(sessionId);
      return json(res, 503, {
        ok: false,
        code: "UNAVAILABLE",
        error: "Talk session unavailable (no gateway request scope)",
      });
    }
    const result = await dispatchTalk(res, "talk.session.close", { sessionId });
    forgetTalkSession(sessionId);
    return result;
  } catch (err) {
    forgetTalkSession(sessionId);
    return json(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function dispatchTalkPayload(
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
    const envelope = errorEnvelope(response, `${method} failed`);
    return {
      ok: false,
      payload: (response.payload ?? {}) as Record<string, unknown>,
      error: typeof envelope.error === "string" ? envelope.error : `${method} failed`,
      code: typeof envelope.code === "string" ? envelope.code : undefined,
      details: envelope.details,
    };
  }
  return { ok: true, payload: (response.payload ?? {}) as Record<string, unknown> };
}
