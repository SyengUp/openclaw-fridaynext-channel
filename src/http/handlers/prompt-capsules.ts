import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken } from "../middleware/auth.js";
import { readJsonBody } from "../middleware/body.js";
import {
  readOrInitCapsules,
  validateCapsulesPayload,
  writeCapsules,
  type PromptCapsulesFile,
} from "../../prompt-capsules/capsules-store.js";

function json(res: ServerResponse, status: number, body: unknown): true {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
  return true;
}

function statePayload(state: PromptCapsulesFile): Record<string, unknown> {
  return {
    storeId: state.storeId,
    revision: state.revision,
    updatedAt: state.updatedAt,
    capsules: state.capsules,
  };
}

/**
 * `GET/PUT /friday-next/prompt-capsules` — gateway-side source of truth for the app's
 * prompt capsules, so a delete+reinstall (or a second device) restores them. A brand-new
 * store is planted with two starter capsules; an existing file is never re-seeded.
 *
 * PUT replaces the whole list. An optional `baseRevision` gives optimistic concurrency:
 * when it doesn't match the stored revision, the write is refused with 409 plus the
 * current state, and the app re-merges and retries once.
 */
export async function handlePromptCapsules(
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
    return json(res, 200, { ok: true, ...statePayload(readOrInitCapsules()) });
  }

  // PUT
  const body = await readJsonBody(req);
  if (!body || !("capsules" in body)) {
    return json(res, 400, { error: "Missing required field: capsules" });
  }

  const validated = validateCapsulesPayload(body.capsules);
  if (!validated.ok) {
    return json(res, 400, { error: validated.error });
  }

  const baseRevisionRaw = body.baseRevision;
  const baseRevision =
    typeof baseRevisionRaw === "number" && Number.isFinite(baseRevisionRaw)
      ? Math.trunc(baseRevisionRaw)
      : undefined;

  const current = readOrInitCapsules();
  if (baseRevision !== undefined && baseRevision !== current.revision) {
    return json(res, 409, { ok: false, conflict: true, ...statePayload(current) });
  }

  const next = writeCapsules(validated.capsules, current);
  return json(res, 200, { ok: true, ...statePayload(next) });
}
