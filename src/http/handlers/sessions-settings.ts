import type { IncomingMessage, ServerResponse } from "node:http";
import {
  setSessionSettings,
  getSessionSettings,
} from "../../session/session-manager.js";
import { readJsonBody } from "../middleware/body.js";
import { extractBearerToken } from "../middleware/auth.js";

const VALID_REASONING = new Set(["on", "off", "stream"]);
const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high"]);

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
    res.end(JSON.stringify({ error: "Unauthorized" }));
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
  const modelRef = typeof body?.modelRef === "string" ? body.modelRef : undefined;

  // Split modelRef "provider/modelId" into providerOverride + modelOverride for OpenClaw
  let providerOverride: string | undefined;
  let modelOverride: string | undefined;
  if (modelRef) {
    const slashIdx = modelRef.indexOf("/");
    if (slashIdx > 0) {
      providerOverride = modelRef.slice(0, slashIdx);
      modelOverride = modelRef.slice(slashIdx + 1);
    } else {
      modelOverride = modelRef;
    }
  }

  const errors: string[] = [];
  if (reasoningLevel !== undefined && !VALID_REASONING.has(reasoningLevel)) {
    errors.push(`reasoningLevel must be one of: ${[...VALID_REASONING].join(", ")}`);
  }
  if (thinkingLevel !== undefined && !VALID_THINKING.has(thinkingLevel)) {
    errors.push(`thinkingLevel must be one of: ${[...VALID_THINKING].join(", ")}`);
  }

  if (errors.length > 0) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: errors.join("; ") }));
    return true;
  }

  setSessionSettings(sessionKey, {
    reasoningLevel,
    thinkingLevel,
    modelRef,
    providerOverride,
    modelOverride,
  });

  const settings = getSessionSettings(sessionKey);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, sessionKey, ...settings }));
  return true;
}
