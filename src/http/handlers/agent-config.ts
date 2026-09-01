/**
 * GET/PUT /friday-next/agents/{id}/config
 *
 * Reads and edits a single agent's runtime configuration — the same fields
 * OpenClaw's ControlUI manages, but written through the plugin's own config
 * channel (`api.runtime.config.mutateConfigFile`, proven by plugin-upgrade) so
 * NO OpenClaw core changes are needed. All edits land in the host agent roster
 * (`agents.entries` on OpenClaw ≥2026.8.1;
 * COMPAT(openclaw<2026.8.1): `agents.list[]` on older hosts — see `agent-roster.ts`),
 * exactly where ControlUI's `config.set` writes.
 *
 * Editable fields:
 *  - model           → roster entry `.model`        (string | {primary,fallbacks})
 *  - thinkingDefault → roster entry `.thinkingDefault`
 *  - tools           → roster entry `.tools`        ({profile,allow,alsoAllow,deny,exec:{mode}})
 *  - skills          → roster entry `.skills`       (string[]; [] disables all, absent inherits defaults)
 *
 * Tools patches merge at the top level of `.tools` (a partial `{"tools":{...}}` must not wipe
 * sibling keys), and `tools.exec` keeps its own null-clear semantics: `{"tools":{"exec":null}}`
 * removes the agent's exec override so the core merge falls back to `agents.defaults`.
 *
 * Clearing an override MUST delete the field (not leave a stale value) so the
 * core's config merge falls back to `agents.defaults` — same hazard documented
 * for the default-model bug. PUT therefore treats an explicit `null` as "clear".
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getFridayAgentForwardRuntime } from "../../agent-forward-runtime.js";
import { getUpgradeRuntime } from "../../upgrade-runtime.js";
import { normalizeAgentId } from "../../agent-id.js";
import { ensureAgentRosterConfig, findAgentRosterConfig } from "../../agent-roster.js";
import { discoverAvailableSkills, type DiscoveredSkill } from "../../skills-discovery.js";
import { extractBearerToken } from "../middleware/auth.js";
import { readJsonBody } from "../middleware/body.js";
import { createFridayNextLogger } from "../../logging.js";

function json(res: ServerResponse, status: number, body: unknown): true {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
  return true;
}

export interface AgentToolsConfig {
  profile?: string;
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
  /** Command-execution policy (`tools.exec`); `mode` only — the field the app edits. */
  exec?: { mode: string };
}

interface AgentConfigView {
  id: string;
  exists: boolean;
  /** Raw model field verbatim (string or {primary,fallbacks}); undefined inherits defaults. */
  model?: unknown;
  thinkingDefault?: string;
  tools?: AgentToolsConfig;
  /** Configured skills allow-list; undefined = inherit defaults, [] = all disabled. */
  skills?: string[];
  /** Full catalog of loadable skills (id + source category + description), best-effort. */
  availableSkills: DiscoveredSkill[];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
  return out;
}

/**
 * Core's config schema pins `tools.exec.mode` to this exact enum. Writing anything else
 * produces a config file the gateway can no longer validate on the next load.
 */
const EXEC_MODES = ["deny", "allowlist", "ask", "auto", "full"] as const;

function readExecConfig(value: unknown): { mode: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const mode = readString((value as Record<string, unknown>)["mode"]);
  return mode && (EXEC_MODES as readonly string[]).includes(mode) ? { mode } : undefined;
}

function readToolsConfig(value: unknown): AgentToolsConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const t = value as Record<string, unknown>;
  const view: AgentToolsConfig = {};
  const profile = readString(t.profile);
  if (profile) view.profile = profile;
  const allow = readStringArray(t.allow);
  if (allow) view.allow = allow;
  const alsoAllow = readStringArray(t.alsoAllow);
  if (alsoAllow) view.alsoAllow = alsoAllow;
  const deny = readStringArray(t.deny);
  if (deny) view.deny = deny;
  const exec = readExecConfig(t.exec);
  if (exec) view.exec = exec;
  return view;
}

function buildConfigView(agentId: string): AgentConfigView {
  const rt = getFridayAgentForwardRuntime();
  const cfg = rt?.getConfig();
  const entry = cfg ? findAgentRosterConfig(cfg, agentId) : undefined;
  return {
    id: agentId,
    exists: entry !== undefined,
    model: entry?.model,
    thinkingDefault: readString(entry?.thinkingDefault),
    tools: readToolsConfig(entry?.tools),
    // undefined = no `skills` field (inherit defaults); [] = field present but empty (all disabled).
    skills: readStringArray(entry?.skills),
    availableSkills: discoverAvailableSkills(cfg, agentId),
  };
}

// --- PUT validation helpers --------------------------------------------------

/** A field present in the body: `undefined` = not sent (keep), `null` = clear, else new value. */
type Patch<T> = { sent: boolean; clear: boolean; value?: T };

function readPatch<T>(
  body: Record<string, unknown>,
  key: string,
  coerce: (raw: unknown) => T | undefined,
): Patch<T> {
  if (!(key in body)) return { sent: false, clear: false };
  const raw = body[key];
  if (raw === null) return { sent: true, clear: true };
  const value = coerce(raw);
  if (value === undefined) return { sent: false, clear: false };
  return { sent: true, clear: false, value };
}

function coerceModel(raw: unknown): unknown {
  if (typeof raw === "string") return raw.trim() || undefined;
  if (raw && typeof raw === "object") {
    const primary = readString((raw as Record<string, unknown>).primary);
    if (!primary) return undefined;
    const fallbacks = readStringArray((raw as Record<string, unknown>).fallbacks);
    return fallbacks && fallbacks.length > 0 ? { primary, fallbacks } : { primary };
  }
  return undefined;
}

/**
 * Core's config schema pins `thinkingDefault` to this exact enum
 * (`zod-schema.agent-runtime.ts` / `zod-schema.agent-defaults.ts`). Writing anything else
 * produces a config file the gateway can no longer validate on the next load, so reject it
 * here rather than persisting a value that bricks config parsing.
 */
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "adaptive",
  "max",
  "ultra",
] as const;

function coerceThinkingDefault(raw: unknown): string | undefined {
  const value = readString(raw)?.toLowerCase();
  return value && (THINKING_LEVELS as readonly string[]).includes(value) ? value : undefined;
}

function coerceTools(raw: unknown): AgentToolsConfig | undefined {
  return readToolsConfig(raw);
}

/** Skills: array (incl. empty = disable all) only; non-arrays are rejected upstream. */
function coerceSkills(raw: unknown): string[] | undefined {
  return Array.isArray(raw) ? (readStringArray(raw) ?? []) : undefined;
}

// --- handler -----------------------------------------------------------------

export async function handleAgentConfig(
  req: IncomingMessage,
  res: ServerResponse,
  rawAgentId: string,
): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "PUT") {
    return json(res, 405, { error: "Method Not Allowed" });
  }
  if (!extractBearerToken(req)) {
    return json(res, 401, { error: "Unauthorized: bearer token mismatch" });
  }

  const agentId = normalizeAgentId(rawAgentId);

  if (req.method === "GET") {
    return json(res, 200, { ok: true, ...buildConfigView(agentId) });
  }

  // PUT — partial patch.
  const body = await readJsonBody(req);
  if (!body) return json(res, 400, { error: "Invalid or missing JSON body" });

  const model = readPatch(body, "model", coerceModel);
  const thinkingDefault = readPatch(body, "thinkingDefault", coerceThinkingDefault);
  const tools = readPatch(body, "tools", coerceTools);
  const skills = readPatch(body, "skills", coerceSkills);

  if ("skills" in body && body.skills !== null && !Array.isArray(body.skills)) {
    return json(res, 400, {
      error: "skills must be an array of skill ids, [] to disable all, or null to inherit defaults",
    });
  }
  // Reject an out-of-enum level loudly — `readPatch` would otherwise treat it as "not sent"
  // and the caller would think the write landed.
  if ("thinkingDefault" in body && body.thinkingDefault !== null && !thinkingDefault.sent) {
    return json(res, 400, {
      error: `thinkingDefault must be one of: ${THINKING_LEVELS.join(", ")}, or null to inherit defaults`,
    });
  }
  // Same loud-reject for a nested `tools.exec.mode` outside the enum (or shaped wrong).
  const execClear = readExecClear(body);
  if (execClear === null) {
    return json(res, 400, {
      error: `tools.exec.mode must be one of: ${EXEC_MODES.join(", ")}, or null to inherit defaults`,
    });
  }
  if (!model.sent && !thinkingDefault.sent && !tools.sent && !skills.sent) {
    return json(res, 400, {
      error: "No editable fields provided (model, thinkingDefault, tools, skills)",
    });
  }

  const upgrade = getUpgradeRuntime();
  if (!upgrade) return json(res, 503, { error: "Config write runtime unavailable" });

  const log = createFridayNextLogger("agent-config");
  try {
    await upgrade.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate: (draftRaw) => {
        const draft = draftRaw as Record<string, unknown>;
        const entry = ensureAgentRosterConfig(draft, agentId);
        applyField(entry, "model", model);
        applyField(entry, "thinkingDefault", thinkingDefault);
        applyToolsPatch(entry, tools, execClear);
        applyField(entry, "skills", skills);
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`agent config write failed for "${agentId}": ${msg}`);
    return json(res, 500, { error: "Failed to write agent config", detail: msg });
  }

  log.info(`agent config updated for "${agentId}"`);
  return json(res, 200, { ok: true, ...buildConfigView(agentId) });
}

/**
 * Whether the PUT body asks to clear `tools.exec` (`{"tools":{"exec":null}}`).
 * Returns `null` when `tools.exec` is present but is NOT `null` and does not carry a valid
 * `mode` — the caller must reject loudly so the app never mistakes a dropped patch for a write.
 */
function readExecClear(body: Record<string, unknown>): boolean | null {
  const toolsBody = body["tools"];
  if (!toolsBody || typeof toolsBody !== "object" || Array.isArray(toolsBody)) return false;
  const execRaw = (toolsBody as Record<string, unknown>)["exec"];
  if (execRaw === undefined) return false;
  if (execRaw === null) return true;
  if (typeof execRaw !== "object" || Array.isArray(execRaw)) return null;
  const mode = readString((execRaw as Record<string, unknown>)["mode"]);
  return mode && (EXEC_MODES as readonly string[]).includes(mode) ? false : null;
}

/**
 * Apply a tools patch by merging at the top level of the roster entry's `.tools` object —
 * a partial `{"tools":{"exec":{"mode":…}}}` must not wipe existing `profile/allow/deny`,
 * and the toolbox's full read-modify-write still lands intact. `execClear` strips only the
 * `exec` key (falling back to `agents.defaults`).
 */
function applyToolsPatch(
  entry: Record<string, unknown>,
  tools: Patch<unknown>,
  execClear: boolean,
): void {
  if (!tools.sent) return;
  if (tools.clear) {
    delete entry.tools;
    return;
  }
  const existing = entry.tools && typeof entry.tools === "object" && !Array.isArray(entry.tools)
    ? { ...(entry.tools as Record<string, unknown>) }
    : {};
  const merged: Record<string, unknown> = {
    ...existing,
    ...((tools.value as Record<string, unknown>) ?? {}),
  };
  if (execClear) delete merged.exec;
  if (Object.keys(merged).length === 0) delete entry.tools;
  else entry.tools = merged;
}

/** Apply a patch: clear → delete the key; set → assign; not sent → leave as-is. */
function applyField(entry: Record<string, unknown>, key: string, patch: Patch<unknown>): void {
  if (!patch.sent) return;
  if (patch.clear) {
    delete entry[key];
    return;
  }
  entry[key] = patch.value;
}
