import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  getFridayAgentForwardRuntime,
  type FridayAgentForwardRuntime,
} from "../../agent-forward-runtime.js";
import { extractBearerToken } from "../middleware/auth.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../agent-id.js";

export interface FridayAgentEntry {
  id: string;
  name?: string;
  description?: string;
  /** Primary model ref (e.g. "openai/gpt-4"); resolved from string or {primary} forms. */
  model?: string;
  thinkingDefault?: string;
  isDefault: boolean;
  emoji?: string;
  avatar?: string;
}

interface ResolvedAgents {
  agents: FridayAgentEntry[];
  defaultAgentId: string;
}

/** Extract a primary model ref from the `model` field (string or {primary,...}). */
function resolvePrimaryModel(model: unknown): string | undefined {
  if (typeof model === "string") return readString(model);
  if (model && typeof model === "object") {
    return readString((model as Record<string, unknown>).primary);
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Unfilled IDENTITY.md template prompts that must not surface as a real name. */
const IDENTITY_NAME_PLACEHOLDERS = new Set(["pick something you like"]);

/**
 * Extract the `Name` field from an agent's IDENTITY.md, mirroring OpenClaw's
 * `parseIdentityMarkdown` (src/agents/identity-file.ts) for the name label only:
 * drop the leading "- ", split on the first ":", strip markdown emphasis, and
 * skip the unfilled template placeholder. Returns the raw value verbatim (e.g.
 * "星期五 (Friday)") so it matches what ControlUI shows under "身份名称".
 */
export function parseIdentityNameFromMarkdown(content: string): string | undefined {
  for (const rawLine of content.split(/\r?\n/)) {
    const cleaned = rawLine.trim().replace(/^\s*-\s*/, "");
    const colonIndex = cleaned.indexOf(":");
    if (colonIndex === -1) continue;
    const label = cleaned.slice(0, colonIndex).replace(/[*_`]/g, "").trim().toLowerCase();
    if (label !== "name") continue;
    const value = cleaned
      .slice(colonIndex + 1)
      .replace(/^[*_`\s]+|[*_`\s]+$/g, "")
      .trim();
    if (!value) continue;
    let normalized = value.replace(/[–—]/g, "-");
    if (normalized.startsWith("(") && normalized.endsWith(")")) {
      normalized = normalized.slice(1, -1).trim();
    }
    if (IDENTITY_NAME_PLACEHOLDERS.has(normalized.toLowerCase())) continue;
    return value;
  }
  return undefined;
}

/**
 * Name fallback for agents with no `name`/`identity.name` in config (e.g. the
 * implicit `main`): resolve the agent's workspace and parse its IDENTITY.md, the
 * same source ControlUI reads. Best-effort — any failure yields undefined.
 */
function readWorkspaceIdentityName(
  rt: FridayAgentForwardRuntime,
  cfg: unknown,
  agentId: string,
): string | undefined {
  const resolveWorkspace = rt.resolveAgentWorkspaceDir;
  if (!resolveWorkspace) return undefined;
  try {
    const workspace = resolveWorkspace(cfg, agentId);
    if (!workspace) return undefined;
    const content = fs.readFileSync(path.join(workspace, "IDENTITY.md"), "utf-8");
    return parseIdentityNameFromMarkdown(content);
  } catch {
    return undefined;
  }
}

/**
 * Reads the configured agents directly from the runtime config (same approach as
 * models-list.ts). When no agents are configured OpenClaw runs an implicit "main"
 * agent, so we return a single default entry to match that behaviour.
 */
function resolveConfiguredAgents(): ResolvedAgents {
  const rt = getFridayAgentForwardRuntime();
  if (!rt) return { agents: [], defaultAgentId: DEFAULT_AGENT_ID };

  const cfg = rt.getConfig() as Record<string, unknown>;
  const agents = cfg?.agents as Record<string, unknown> | undefined;
  const list = agents?.list as Array<Record<string, unknown>> | undefined;

  if (!Array.isArray(list) || list.length === 0) {
    return {
      agents: [{ id: DEFAULT_AGENT_ID, isDefault: true }],
      defaultAgentId: DEFAULT_AGENT_ID,
    };
  }

  // Default agent: first entry marked `default: true`, else the first entry.
  const explicitDefault = list.find((a) => a?.default === true);
  const defaultAgentId = normalizeAgentId((explicitDefault ?? list[0])?.id);

  const seen = new Set<string>();
  const entries: FridayAgentEntry[] = [];
  for (const agent of list) {
    if (!agent || typeof agent !== "object") continue;
    const id = normalizeAgentId(agent.id);
    if (seen.has(id)) continue;
    seen.add(id);

    const identity = agent.identity as Record<string, unknown> | undefined;
    entries.push({
      id,
      name:
        readString(agent.name) ??
        readString(identity?.name) ??
        readWorkspaceIdentityName(rt, cfg, id),
      description: readString(agent.description),
      model: resolvePrimaryModel(agent.model),
      thinkingDefault: readString(agent.thinkingDefault),
      isDefault: id === defaultAgentId,
      emoji: readString(identity?.emoji),
      avatar: readString(identity?.avatar) ?? readString(identity?.avatarUrl),
    });
  }

  return { agents: entries, defaultAgentId };
}

export async function handleAgentsList(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET") {
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

  const { agents, defaultAgentId } = resolveConfiguredAgents();

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, agents, defaultAgentId }));
  return true;
}
