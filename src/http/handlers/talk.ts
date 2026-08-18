/**
 * Talk mode admin surface for the app.
 *
 *   GET  /friday-next-admin/talk/catalog  → `talk.catalog`
 *   GET  /friday-next-admin/talk/config   → `talk.config` (never includeSecrets)
 *   POST /friday-next-admin/talk/speak    → `talk.speak`
 *   POST /friday-next-admin/talk/mode     → `talk.mode`
 *
 * WHY THE `/friday-next-admin` SIBLING PREFIX (not `/friday-next`):
 * `/friday-next` is registered `auth: "plugin"`, and core gives plugin-authed routes a
 * runtime client with an EMPTY operator scope list, so dispatching any scoped method
 * from there is refused. A gateway-authed route cannot overlap that prefix, so these
 * live next door — same reasoning as `commands-list.ts` / `cron.ts`.
 *
 * SCOPES (src/gateway/methods/core-descriptors.ts):
 *   `talk.catalog` / `talk.config`  → operator.read
 *   `talk.speak` / `talk.mode`      → operator.write
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

const CATALOG_PATH = "/friday-next-admin/talk/catalog";
const CONFIG_PATH = "/friday-next-admin/talk/config";
const SPEAK_PATH = "/friday-next-admin/talk/speak";
const MODE_PATH = "/friday-next-admin/talk/mode";

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
 * Returns false when the pathname is not one of the four Talk routes so other
 * prefix matches (none today) can keep looking.
 */
export async function handleTalk(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (
    pathname !== CATALOG_PATH &&
    pathname !== CONFIG_PATH &&
    pathname !== SPEAK_PATH &&
    pathname !== MODE_PATH
  ) {
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

  if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });
  const body = await readJsonBody(req);
  if (!body) return json(res, 400, { ok: false, error: "invalid JSON body" });
  if (typeof body.enabled !== "boolean") {
    return json(res, 400, { ok: false, error: "talk.mode requires enabled: boolean" });
  }
  const params: Record<string, unknown> = { enabled: body.enabled };
  const phase = optionalNonEmptyString(body.phase);
  if (phase) params.phase = phase;
  return await dispatchTalk(res, "talk.mode", params);
}
