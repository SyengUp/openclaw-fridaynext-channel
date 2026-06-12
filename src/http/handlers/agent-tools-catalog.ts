/**
 * GET /friday-next/agents/{id}/tools/catalog
 *
 * Returns the agent's full tool catalog (core + plugin tools, grouped by category,
 * with descriptions, profiles, and per-tool effective `enabled`/`inProfile` state) for
 * the app's toolbox editor — mirroring ControlUI. Edits are saved via the existing
 * `PUT /agents/{id}/config` (tools.{profile,allow,alsoAllow,deny}).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getFridayAgentForwardRuntime } from "../../agent-forward-runtime.js";
import { normalizeAgentId } from "../../agent-id.js";
import { buildAgentToolsCatalog } from "../../tool-catalog.js";
import { extractBearerToken } from "../middleware/auth.js";

function json(res: ServerResponse, status: number, body: unknown): true {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
  return true;
}

export async function handleAgentToolsCatalog(
  req: IncomingMessage,
  res: ServerResponse,
  rawAgentId: string,
): Promise<boolean> {
  if (req.method !== "GET") {
    return json(res, 405, { error: "Method Not Allowed" });
  }
  if (!extractBearerToken(req)) {
    return json(res, 401, { error: "Unauthorized: bearer token mismatch" });
  }

  const agentId = normalizeAgentId(rawAgentId);
  const cfg = getFridayAgentForwardRuntime()?.getConfig();
  const catalog = await buildAgentToolsCatalog(cfg, agentId);
  if (!catalog) {
    return json(res, 503, { error: "Tool catalog unavailable" });
  }
  return json(res, 200, { ok: true, id: agentId, ...catalog });
}
