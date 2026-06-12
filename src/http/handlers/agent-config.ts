/**
 * GET/PUT /friday-next/agents/{id}/config
 *
 * Reads and edits a single agent's runtime configuration — the same fields
 * OpenClaw's ControlUI manages, but written through the plugin's own config
 * channel (`api.runtime.config.mutateConfigFile`, proven by plugin-upgrade) so
 * NO OpenClaw core changes are needed. All edits land in `agents.list[]` of the
 * host config file (`~/.clawrc`), exactly where ControlUI's `config.set` writes.
 *
 * Editable fields:
 *  - model           → agents.list[i].model        (string | {primary,fallbacks})
 *  - thinkingDefault → agents.list[i].thinkingDefault
 *  - tools           → agents.list[i].tools        ({profile,allow,alsoAllow,deny})
 *  - skills          → agents.list[i].skills       (string[]; [] disables all, absent inherits defaults)
 *
 * Clearing an override MUST delete the field (not leave a stale value) so the
 * core's config merge falls back to `agents.defaults` — same hazard documented
 * for the default-model bug. PUT therefore treats an explicit `null` as "clear".
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getFridayAgentForwardRuntime } from "../../agent-forward-runtime.js";
import { getUpgradeRuntime } from "../../upgrade-runtime.js";
import { normalizeAgentId } from "../../agent-id.js";
import { discoverAvailableSkills } from "../../skills-discovery.js";
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
  /** Skill ids discovered in the agent's workspace `skills/` dir (best-effort). */
  availableSkills: string[];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
  return out;
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
  return view;
}

/** Locate the configured `agents.list[]` entry whose normalized id matches `agentId`. */
function findAgentEntry(cfg: unknown, agentId: string): Record<string, unknown> | undefined {
  const agents = (cfg as Record<string, unknown> | undefined)?.agents as Record<string, unknown> | undefined;
  const list = agents?.list as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(list)) return undefined;
  return list.find((a) => a && typeof a === "object" && normalizeAgentId(a.id) === agentId);
}

function buildConfigView(agentId: string): AgentConfigView {
  const rt = getFridayAgentForwardRuntime();
  const cfg = rt?.getConfig();
  const entry = cfg ? findAgentEntry(cfg, agentId) : undefined;
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

function readPatch<T>(body: Record<string, unknown>, key: string, coerce: (raw: unknown) => T | undefined): Patch<T> {
  if (!(key in body)) return { sent: false, clear: false };
  const raw = body[key];
  if (raw === null) return { sent: true, clear: true };
  const value = coerce(raw);
  if (value === undefined) return { sent: false, clear: false };
  return { sent: true, clear: false, value };
}

function coerceModel(raw: unknown): unknown | undefined {
  if (typeof raw === "string") return raw.trim() || undefined;
  if (raw && typeof raw === "object") {
    const primary = readString((raw as Record<string, unknown>).primary);
    if (!primary) return undefined;
    const fallbacks = readStringArray((raw as Record<string, unknown>).fallbacks);
    return fallbacks && fallbacks.length > 0 ? { primary, fallbacks } : { primary };
  }
  return undefined;
}

function coerceTools(raw: unknown): AgentToolsConfig | undefined {
  return readToolsConfig(raw);
}

/** Skills: array (incl. empty = disable all) only; non-arrays are rejected upstream. */
function coerceSkills(raw: unknown): string[] | undefined {
  return Array.isArray(raw) ? readStringArray(raw) ?? [] : undefined;
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
  const thinkingDefault = readPatch(body, "thinkingDefault", (r) => readString(r));
  const tools = readPatch(body, "tools", coerceTools);
  const skills = readPatch(body, "skills", coerceSkills);

  if ("skills" in body && body.skills !== null && !Array.isArray(body.skills)) {
    return json(res, 400, { error: "skills must be an array of skill ids, [] to disable all, or null to inherit defaults" });
  }
  if (!model.sent && !thinkingDefault.sent && !tools.sent && !skills.sent) {
    return json(res, 400, { error: "No editable fields provided (model, thinkingDefault, tools, skills)" });
  }

  const upgrade = getUpgradeRuntime();
  if (!upgrade) return json(res, 503, { error: "Config write runtime unavailable" });

  const log = createFridayNextLogger("agent-config");
  try {
    await upgrade.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate: (draftRaw) => {
        const draft = draftRaw as Record<string, unknown>;
        const agents = (draft.agents ??= {}) as Record<string, unknown>;
        const list = (agents.list ??= []) as Array<Record<string, unknown>>;
        let entry = list.find((a) => a && typeof a === "object" && normalizeAgentId(a.id) === agentId);
        if (!entry) {
          // Implicit agent (e.g. "main") with no list entry yet — create a bare one.
          // Never set `default: true`: that would change default-agent resolution.
          entry = { id: agentId };
          list.push(entry);
        }
        applyField(entry, "model", model);
        applyField(entry, "thinkingDefault", thinkingDefault);
        applyField(entry, "tools", tools);
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

/** Apply a patch: clear → delete the key; set → assign; not sent → leave as-is. */
function applyField(entry: Record<string, unknown>, key: string, patch: Patch<unknown>): void {
  if (!patch.sent) return;
  if (patch.clear) {
    delete entry[key];
    return;
  }
  entry[key] = patch.value;
}
