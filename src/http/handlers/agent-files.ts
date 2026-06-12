/**
 * GET/PUT /friday-next/agents/{id}/files[/{name}]
 *
 * Reads and edits an agent's core workspace files — the same whitelist ControlUI
 * exposes (AGENTS/IDENTITY/SOUL/TOOLS/MEMORY/USER/HEARTBEAT/BOOTSTRAP.md). These
 * are plain workspace files, not config: written directly via Node fs into the
 * dir resolved by `api.runtime.agent.resolveAgentWorkspaceDir` (the same call
 * agents-list uses to read IDENTITY.md). No config mutation, no gateway restart —
 * the agent re-reads them on its next run.
 *
 *  - GET  /agents/{id}/files          → status of every whitelist file
 *  - GET  /agents/{id}/files/{name}   → one file's content
 *  - PUT  /agents/{id}/files/{name}   → write one file (body: { content })
 *
 * Security: the file name MUST be in the whitelist (no path traversal), and the
 * resolved path is re-checked to stay inside the workspace dir as defense in depth.
 */

import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getFridayAgentForwardRuntime } from "../../agent-forward-runtime.js";
import { normalizeAgentId } from "../../agent-id.js";
import { extractBearerToken } from "../middleware/auth.js";
import { readJsonBody } from "../middleware/body.js";
import { createFridayNextLogger } from "../../logging.js";

/** Core workspace files an agent edits, mirroring ControlUI's `agents.files` whitelist. */
export const CORE_AGENT_FILES = [
  "AGENTS.md",
  "IDENTITY.md",
  "SOUL.md",
  "TOOLS.md",
  "MEMORY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
] as const;

const CORE_FILE_SET = new Set<string>(CORE_AGENT_FILES);

/** Max core-file size on write (256 KiB) — these are prompts, not data dumps. */
const MAX_FILE_BYTES = 256 * 1024;

function json(res: ServerResponse, status: number, body: unknown): true {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
  return true;
}

/** Resolve the agent's workspace dir, or undefined if the runtime can't. */
function resolveWorkspace(agentId: string): string | undefined {
  const rt = getFridayAgentForwardRuntime();
  if (!rt?.resolveAgentWorkspaceDir) return undefined;
  try {
    const dir = rt.resolveAgentWorkspaceDir(rt.getConfig(), agentId);
    return dir || undefined;
  } catch {
    return undefined;
  }
}

/** Whitelisted, traversal-safe absolute path for `name` inside `workspace`, or null. */
function safeFilePath(workspace: string, name: string): string | null {
  if (!CORE_FILE_SET.has(name)) return null;
  const resolved = path.resolve(workspace, name);
  // Defense in depth: the resolved path must sit directly inside the workspace.
  if (path.dirname(resolved) !== path.resolve(workspace)) return null;
  return resolved;
}

export async function handleAgentFiles(
  req: IncomingMessage,
  res: ServerResponse,
  rawAgentId: string,
  fileName: string | undefined,
): Promise<boolean> {
  const method = req.method;
  if (method !== "GET" && method !== "PUT") {
    return json(res, 405, { error: "Method Not Allowed" });
  }
  if (!extractBearerToken(req)) {
    return json(res, 401, { error: "Unauthorized: bearer token mismatch" });
  }

  const agentId = normalizeAgentId(rawAgentId);
  const workspace = resolveWorkspace(agentId);
  if (!workspace) return json(res, 503, { error: "Agent workspace not resolvable" });

  // GET /files — list whitelist status.
  if (method === "GET" && !fileName) {
    const files = CORE_AGENT_FILES.map((name) => {
      try {
        const stat = fs.statSync(path.join(workspace, name));
        return { name, exists: true, bytes: stat.size };
      } catch {
        return { name, exists: false, bytes: 0 };
      }
    });
    return json(res, 200, { ok: true, id: agentId, files });
  }

  if (!fileName || !CORE_FILE_SET.has(fileName)) {
    return json(res, 400, {
      error: `Unknown core file; allowed: ${CORE_AGENT_FILES.join(", ")}`,
    });
  }
  const filePath = safeFilePath(workspace, fileName);
  if (!filePath) return json(res, 400, { error: "Invalid file name" });

  if (method === "GET") {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return json(res, 200, { ok: true, id: agentId, name: fileName, exists: true, content });
    } catch {
      return json(res, 200, { ok: true, id: agentId, name: fileName, exists: false, content: "" });
    }
  }

  // PUT — write content.
  const body = await readJsonBody(req);
  if (!body || typeof body.content !== "string") {
    return json(res, 400, { error: "Missing required field: content (string)" });
  }
  const content = body.content;
  if (Buffer.byteLength(content, "utf-8") > MAX_FILE_BYTES) {
    return json(res, 413, { error: `content exceeds ${MAX_FILE_BYTES} bytes` });
  }

  const log = createFridayNextLogger("agent-files");
  try {
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`write ${fileName} for "${agentId}" failed: ${msg}`);
    return json(res, 500, { error: "Failed to write file", detail: msg });
  }

  log.info(`wrote ${fileName} for "${agentId}" (${Buffer.byteLength(content, "utf-8")} bytes)`);
  return json(res, 200, {
    ok: true,
    id: agentId,
    name: fileName,
    exists: true,
    bytes: Buffer.byteLength(content, "utf-8"),
  });
}
