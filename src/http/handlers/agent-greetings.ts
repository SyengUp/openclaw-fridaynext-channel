import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeAgentId } from "../../agent-id.js";
import {
  readGreetingFor,
  setGreeting,
  validateGreeting,
} from "../../agent-greetings/greetings-store.js";
import { extractBearerToken } from "../middleware/auth.js";
import { readJsonBody } from "../middleware/body.js";

function json(res: ServerResponse, status: number, body: unknown): true {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
  return true;
}

/**
 * `GET/PUT /friday-next/agents/{id}/greeting` — a single agent's home-greeting
 * override ("首页问候语"), stored gateway-side so every paired device shows the
 * same greeting and a delete+reinstall restores it.
 *
 * GET → `{ greeting: string | null }` (null = no override; the app falls back to
 * its localized default). PUT body `{ greeting }` (trimmed, ≤60 chars); an empty
 * string clears the override. Written to the plugin's own JSON store — never into
 * `agents.list[]` (core schema is strict, unknown fields would brick config load).
 */
export async function handleAgentGreeting(
  req: IncomingMessage,
  res: ServerResponse,
  rawAgentId: string,
): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "PUT") {
    return json(res, 405, { error: "Method Not Allowed" });
  }

  const token = extractBearerToken(req);
  if (!token) {
    return json(res, 401, { error: "Unauthorized: bearer token mismatch" });
  }

  const agentId = normalizeAgentId(rawAgentId);

  if (req.method === "GET") {
    return json(res, 200, { ok: true, greeting: readGreetingFor(agentId) ?? null });
  }

  // PUT
  const body = await readJsonBody(req);
  if (!body || !("greeting" in body)) {
    return json(res, 400, { error: "Missing required field: greeting" });
  }
  const validated = validateGreeting(body.greeting);
  if (!validated.ok) {
    return json(res, 400, { error: validated.error });
  }
  const next = setGreeting(agentId, validated.greeting);
  return json(res, 200, { ok: true, greeting: next.greetings[agentId] ?? null });
}
