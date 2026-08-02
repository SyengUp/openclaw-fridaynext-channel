import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken } from "../middleware/auth.js";
import { readJsonBody } from "../middleware/body.js";
import {
  readServerName,
  validateServerName,
  writeServerName,
  type ServerNameFile,
} from "../../server-name/server-name-store.js";

function json(res: ServerResponse, status: number, body: unknown): true {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
  return true;
}

function statePayload(state: ServerNameFile): Record<string, unknown> {
  return { name: state.name, updatedAt: state.updatedAt };
}

/**
 * `GET/PUT /friday-next/server-name` — this gateway's user-facing display name,
 * stored gateway-side so every paired device sees the same name and a
 * delete+reinstall restores it. PUT with an empty string clears the name.
 */
export async function handleServerName(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "PUT") {
    return json(res, 405, { error: "Method Not Allowed" });
  }

  const token = extractBearerToken(req);
  if (!token) {
    return json(res, 401, { error: "Unauthorized: bearer token mismatch" });
  }

  if (req.method === "GET") {
    return json(res, 200, { ok: true, ...statePayload(readServerName()) });
  }

  // PUT
  const body = await readJsonBody(req);
  if (!body || !("name" in body)) {
    return json(res, 400, { error: "Missing required field: name" });
  }
  const validated = validateServerName(body.name);
  if (!validated.ok) {
    return json(res, 400, { error: validated.error });
  }
  return json(res, 200, { ok: true, ...statePayload(writeServerName(validated.name)) });
}
