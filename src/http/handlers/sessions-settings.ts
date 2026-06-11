import type { IncomingMessage, ServerResponse } from "node:http";
import {
  setSessionSettings,
  getSessionSettings,
  splitModelRef,
  resolveAgentDefaults,
  type FridaySessionSettingsUpdate,
} from "../../session/session-manager.js";
import { readJsonBody } from "../middleware/body.js";
import { extractBearerToken } from "../middleware/auth.js";
import { resolveModelThinkingForRef } from "../../thinking-levels.js";

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
    const settings = getSessionSettings(sessionKey);
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

  // The app omits (or empties) modelRef to mean "use the agent's default model". Resolve that
  // default and write it as an *explicit* override, identical in shape to any other selection — so
  // the agent runs the default exactly the way it runs an explicitly-picked model. Do NOT just
  // clear the override here: the session entry is shared with the OpenClaw core, which stamps it
  // with provenance fields (`modelOverrideSource`, `model`, `modelProvider`); deleting only our
  // three fields leaves those dangling and the core mis-resolves to a fallback model.
  const effectiveModelRef = modelRef || resolveAgentDefaults(sessionKey).model;

  const errors: string[] = [];
  if (reasoningLevel !== undefined && !VALID_REASONING.has(reasoningLevel)) {
    errors.push(`reasoningLevel must be one of: ${[...VALID_REASONING].join(", ")}`);
  }
  if (thinkingLevel !== undefined) {
    // Thinking levels vary per model, so validate against the levels the *effective* model supports
    // (resolved from the running gateway). Falls back to the base five levels when unresolvable.
    const supported = resolveModelThinkingForRef(effectiveModelRef).levels.map((l) => l.id);
    if (!supported.includes(thinkingLevel)) {
      errors.push(`thinkingLevel must be one of: ${supported.join(", ")}`);
    }
  }

  if (errors.length > 0) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: errors.join("; ") }));
    return true;
  }

  const settings: FridaySessionSettingsUpdate = { reasoningLevel, thinkingLevel };
  if (effectiveModelRef) {
    const split = splitModelRef(effectiveModelRef);
    settings.modelRef = effectiveModelRef;
    // `?? null` clears a stale provider when the ref is bare (no `provider/` prefix).
    settings.providerOverride = split.provider ?? null;
    settings.modelOverride = split.modelId;
  } else {
    // No configured default to resolve (e.g. config unavailable) — clear rather than pin a stale model.
    settings.modelRef = null;
    settings.providerOverride = null;
    settings.modelOverride = null;
  }

  const result = setSessionSettings(sessionKey, settings);

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, sessionKey, ...result }));
  return true;
}
