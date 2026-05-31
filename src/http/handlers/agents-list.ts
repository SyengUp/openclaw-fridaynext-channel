import type { IncomingMessage, ServerResponse } from "node:http";
import { getFridayAgentForwardRuntime } from "../../agent-forward-runtime.js";
import { extractBearerToken } from "../middleware/auth.js";

const DEFAULT_AGENT_ID = "main";

/** Agent ids already in path/shell-safe form skip the slug rewrite below. */
const SAFE_AGENT_ID = /^[a-z0-9][a-z0-9_-]*$/;

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

/**
 * Mirror of OpenClaw's `normalizeAgentId` (src/routing/session-key.ts): trim,
 * lowercase, keep path/shell-safe. Empty → "main".
 */
function normalizeAgentId(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return DEFAULT_AGENT_ID;
  const lowered = trimmed.toLowerCase();
  if (SAFE_AGENT_ID.test(lowered)) return lowered;
  return (
    lowered
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
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
      name: readString(agent.name) ?? readString(identity?.name),
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
