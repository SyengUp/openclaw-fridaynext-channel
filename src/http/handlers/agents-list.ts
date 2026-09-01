import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  getFridayAgentForwardRuntime,
  type FridayAgentForwardRuntime,
} from "../../agent-forward-runtime.js";
import { extractBearerToken } from "../middleware/auth.js";
import { DEFAULT_AGENT_ID } from "../../agent-id.js";
import {
  listAgentRoster,
  resolveRosterDefaultAgentId,
} from "../../agent-roster.js";
import { readGreetingFor } from "../../agent-greetings/greetings-store.js";
import { resolveDefaultPermissionMode } from "../../session/session-manager.js";

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
  /** Custom home-greeting override (undefined = none → app falls back to its localized default). */
  greeting?: string;
  /**
   * Display-only inherited session permission (Control UI "Default (Guarded)" label).
   * Omitted when the effective policy cannot be stated at agent scope.
   */
  defaultPermissionMode?: string;
}

interface ResolvedAgents {
  agents: FridayAgentEntry[];
  defaultAgentId: string;
  /**
   * Global inherited session permission (`tools.exec.mode` at `agents.defaults` or top level) —
   * what an agent with no exec override runs. Lets the app label the "inherit" row.
   */
  defaultPermissionMode?: string;
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
 * models-list.ts). OpenClaw ≥2026.8.1 stores the roster at `agents.entries`.
 * COMPAT(openclaw<2026.8.1): older hosts keep `agents.list` (see `agent-roster.ts`).
 * When neither is present OpenClaw runs an implicit "main" agent, so we return a
 * single default entry to match that behaviour.
 */
export function resolveConfiguredAgents(): ResolvedAgents {
  const rt = getFridayAgentForwardRuntime();
  if (!rt) return { agents: [], defaultAgentId: DEFAULT_AGENT_ID };

  const cfg = rt.getConfig() as Record<string, unknown>;
  const agents = cfg?.agents as Record<string, unknown> | undefined;
  const roster = listAgentRoster(cfg);

  // Agent-level default thinking level inherited by every agent that doesn't set
  // its own `thinkingDefault` (e.g. the built-in `main`, which relies on this).
  // Mirrors core `resolveThinkingDefault`, which returns `agents.defaults.thinkingDefault`
  // ahead of any model-specific default. Without this, an inheriting agent is reported
  // with no default, and the app falls back to the (volatile) per-model server default.
  const agentDefaults = agents?.defaults as Record<string, unknown> | undefined;
  const inheritedThinkingDefault = readString(agentDefaults?.thinkingDefault);
  const defaultPermissionMode = resolveDefaultPermissionMode(cfg);

  if (roster.length === 0) {
    // Implicit `main` agent (no roster): config carries no name, so fall
    // back to the workspace IDENTITY.md `Name` — the same source ControlUI and
    // the list branch below use — instead of letting the app show the raw id.
    const name = readWorkspaceIdentityName(rt, cfg, DEFAULT_AGENT_ID);
    return {
      agents: [
        {
          id: DEFAULT_AGENT_ID,
          isDefault: true,
          ...(name ? { name } : {}),
          ...(inheritedThinkingDefault ? { thinkingDefault: inheritedThinkingDefault } : {}),
          ...(readGreetingFor(DEFAULT_AGENT_ID)
            ? { greeting: readGreetingFor(DEFAULT_AGENT_ID) }
            : {}),
          ...(defaultPermissionMode ? { defaultPermissionMode } : {}),
        },
      ],
      defaultAgentId: DEFAULT_AGENT_ID,
      ...(defaultPermissionMode ? { defaultPermissionMode } : {}),
    };
  }

  const defaultAgentId = resolveRosterDefaultAgentId(cfg);
  const entries: FridayAgentEntry[] = [];
  for (const { id, config: agent } of roster) {
    const identity = agent.identity as Record<string, unknown> | undefined;
    const agentPermissionMode = resolveDefaultPermissionMode(cfg, agent);
    entries.push({
      id,
      name:
        readString(agent.name) ??
        readString(identity?.name) ??
        readWorkspaceIdentityName(rt, cfg, id),
      description: readString(agent.description),
      model: resolvePrimaryModel(agent.model),
      thinkingDefault: readString(agent.thinkingDefault) ?? inheritedThinkingDefault,
      isDefault: id === defaultAgentId,
      emoji: readString(identity?.emoji),
      avatar: readString(identity?.avatar) ?? readString(identity?.avatarUrl),
      greeting: readGreetingFor(id),
      ...(agentPermissionMode ? { defaultPermissionMode: agentPermissionMode } : {}),
    });
  }

  return { agents: entries, defaultAgentId, ...(defaultPermissionMode ? { defaultPermissionMode } : {}) };
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

  const { agents, defaultAgentId, defaultPermissionMode } = resolveConfiguredAgents();

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      ok: true,
      agents,
      defaultAgentId,
      ...(defaultPermissionMode ? { defaultPermissionMode } : {}),
    }),
  );
  return true;
}
