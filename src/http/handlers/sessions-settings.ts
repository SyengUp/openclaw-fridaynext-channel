import type { IncomingMessage, ServerResponse } from "node:http";
import {
  setSessionSettings,
  getSessionSettings,
  splitModelRef,
  resolveAgentDefaults,
  isSessionPermissionMode,
  SESSION_PERMISSION_MODES,
  type FridaySessionSettingsUpdate,
  type SessionPermissionMode,
} from "../../session/session-manager.js";
import { readJsonBody } from "../middleware/body.js";
import { extractBearerToken } from "../middleware/auth.js";
import { resolveFridayNextConfig } from "../../config.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { getFridayNextRuntime } from "../../runtime.js";
import { resolveModelThinkingForRef } from "../../thinking-levels.js";

function pluginHistoryDir(): string | undefined {
  try {
    return resolveFridayNextConfig(
      getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
    ).historyDir;
  } catch {
    return undefined;
  }
}

const VALID_REASONING = new Set(["on", "off", "stream"]);

export async function handleSessionsSettings(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "PUT" && req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return true;
  }

  const token = extractBearerToken(req);
  if (!token) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Unauthorized: bearer token mismatch" }));
    return true;
  }

  if (req.method === "GET") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const sessionKey = (url.searchParams.get("sessionKey") ?? "").trim();
    if (!sessionKey) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Missing required query param: sessionKey" }));
      return true;
    }
    const settings = getSessionSettings(sessionKey, pluginHistoryDir());
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, sessionKey, ...settings }));
    return true;
  }

  // PUT
  const body = await readJsonBody(req);
  const sessionKey = typeof body?.sessionKey === "string" ? body.sessionKey.trim() : "";
  if (!sessionKey) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing required field: sessionKey" }));
    return true;
  }

  const reasoningLevel = typeof body?.reasoningLevel === "string" ? body.reasoningLevel : undefined;
  const thinkingLevel = typeof body?.thinkingLevel === "string" ? body.thinkingLevel : undefined;
  const modelRef = typeof body?.modelRef === "string" ? body.modelRef.trim() : undefined;
  const permissionModeResult = parsePermissionModeField(body);
  // Permission-only PUT: don't validate/pin model+thinking. Bundling them made a stale
  // thinkingLevel 400 the whole request, so Control UI never saw the permission write.
  const permissionOnly =
    permissionModeResult.value !== undefined &&
    !permissionModeResult.error &&
    reasoningLevel === undefined &&
    thinkingLevel === undefined &&
    modelRef === undefined;

  const errors: string[] = [];
  if (permissionModeResult.error) {
    errors.push(permissionModeResult.error);
  }

  let effectiveModelRef: string | undefined;
  if (!permissionOnly) {
    // The app omits (or empties) modelRef to mean "use the agent's default model". Resolve that
    // default and write it as an *explicit* override, identical in shape to any other selection — so
    // the agent runs the default exactly the way it runs an explicitly-picked model. Do NOT just
    // clear the override here: the session entry is shared with the OpenClaw core, which stamps it
    // with provenance fields (`modelOverrideSource`, `model`, `modelProvider`); deleting only our
    // three fields leaves those dangling and the core mis-resolves to a fallback model.
    effectiveModelRef = modelRef || resolveAgentDefaults(sessionKey).model;

    if (reasoningLevel !== undefined && !VALID_REASONING.has(reasoningLevel)) {
      errors.push(`reasoningLevel must be one of: ${[...VALID_REASONING].join(", ")}`);
    }
    if (thinkingLevel !== undefined) {
      const supported = resolveModelThinkingForRef(effectiveModelRef).levels.map((l) => l.id);
      if (!supported.includes(thinkingLevel)) {
        errors.push(`thinkingLevel must be one of: ${supported.join(", ")}`);
      }
    }
  }

  if (errors.length > 0) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: errors.join("; ") }));
    return true;
  }

  const settings: FridaySessionSettingsUpdate = {};
  if (permissionModeResult.value !== undefined) {
    settings.permissionMode = permissionModeResult.value;
  }
  if (!permissionOnly) {
    settings.reasoningLevel = reasoningLevel;
    settings.thinkingLevel = thinkingLevel;
    if (effectiveModelRef) {
      const split = splitModelRef(effectiveModelRef);
      settings.modelRef = effectiveModelRef;
      // `?? null` clears a stale provider when the ref is bare (no `provider/` prefix).
      settings.providerOverride = split.provider ?? null;
      settings.modelOverride = split.modelId;
    } else {
      settings.modelRef = null;
      settings.providerOverride = null;
      settings.modelOverride = null;
    }
  }

  const result = await setSessionSettings(sessionKey, settings, pluginHistoryDir());

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, sessionKey, ...result }));
  return true;
}

function parsePermissionModeField(
  body: Record<string, unknown> | null,
): { value?: SessionPermissionMode | null; error?: string } {
  if (!body || !Object.hasOwn(body, "permissionMode")) return {};
  const value = body.permissionMode;
  if (value === null) return { value: null };
  if (isSessionPermissionMode(value)) return { value };
  return {
    error: `permissionMode must be one of: ${SESSION_PERMISSION_MODES.join(", ")}`,
  };
}
