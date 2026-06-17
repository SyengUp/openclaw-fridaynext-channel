import { join } from "node:path";
import os from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { getFridayAgentForwardRuntime } from "../agent-forward-runtime.js";

const FRIDAY_AGENT_ID = "main";
const SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
/** Path/shell-safe agent id (mirrors OpenClaw's `normalizeAgentId`). Anything else falls back to `main`. */
const SAFE_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

function deriveOpenClawBaseDir(historyDir?: string): string {
  if (historyDir) {
    const match = historyDir.replace(/[\\/]+$/, "").match(/(.*[\\/]\.openclaw)[\\/]/);
    if (match?.[1]) return match[1];
  }
  return join(os.homedir(), ".openclaw");
}

export function splitModelRef(modelRef: string): { provider?: string; modelId: string } {
  const slashIdx = modelRef.indexOf("/");
  if (slashIdx > 0) {
    return { provider: modelRef.slice(0, slashIdx), modelId: modelRef.slice(slashIdx + 1) };
  }
  return { modelId: modelRef };
}

export function toSessionStoreKey(rawSessionKey: string): string {
  const raw = rawSessionKey.trim();
  const lowered = raw.trim().toLowerCase();
  if (!raw || lowered === "main") {
    return `agent:${FRIDAY_AGENT_ID}:main`;
  }
  const parts = lowered.split(":").filter(Boolean);
  if (parts.length >= 3 && parts[0] === "agent") {
    const agentId = parts[1];
    const rest = parts.slice(2).join(":");
    if (agentId && rest) {
      return `agent:${agentId}:${rest}`;
    }
  }
  if (lowered.startsWith("agent:")) {
    return lowered;
  }
  return `agent:${FRIDAY_AGENT_ID}:${lowered}`;
}

/**
 * Extract the agent id from a (possibly raw) session key. The downstream app now owns the
 * full `agent:<id>:<rest>` key, so non-`main` agents must read/write their own session store
 * directory. `agent:<id>:<rest>` → `<id>`; bare/legacy keys (or an unsafe id) → `main`.
 */
export function agentIdFromSessionKey(rawSessionKey: string): string {
  const canonical = toSessionStoreKey(rawSessionKey);
  const id = canonical.match(/^agent:([^:]+):/)?.[1];
  return id && SAFE_AGENT_ID_RE.test(id) ? id : FRIDAY_AGENT_ID;
}

function toSafeSessionId(raw: string): string {
  const s = raw.trim();
  if (SESSION_ID_RE.test(s)) return s;
  const slug = s
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  const base = slug || "session";
  const prefixed = /^[a-z0-9]/i.test(base) ? base : `s${base}`;
  return prefixed.slice(0, 128);
}

function sessionIdForSessionsFile(fileKey: string, rawSessionKey: string): string {
  const candidates = [rawSessionKey.trim(), fileKey.trim()];
  for (const c of candidates) {
    if (SESSION_ID_RE.test(c)) return c;
    const tail = c.match(/^agent:[^:]+:(.+)$/)?.[1];
    if (tail) {
      if (SESSION_ID_RE.test(tail)) return tail;
      return toSafeSessionId(tail);
    }
  }
  return toSafeSessionId(rawSessionKey || fileKey);
}

function resolveSessionsFilePath(historyDir: string | undefined, agentId: string): string {
  const base = deriveOpenClawBaseDir(historyDir);
  return join(base, "agents", agentId, "sessions", "sessions.json");
}

function readSessionsData(path: string): Record<string, Record<string, unknown>> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, Record<string, unknown>>;
  } catch {
    return null;
  }
}

function writeSessionsData(path: string, data: Record<string, Record<string, unknown>>): void {
  try {
    writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // best-effort
  }
}

function upsertSessionEntry(
  data: Record<string, Record<string, unknown>>,
  fileKey: string,
  sessionKey: string,
): void {
  const safeSessionId = sessionIdForSessionsFile(fileKey, sessionKey);
  if (!data[fileKey]) {
    data[fileKey] = { sessionId: safeSessionId, updatedAt: Date.now(), systemSent: true };
  }
  const currentSessionId = data[fileKey]["sessionId"];
  if (typeof currentSessionId !== "string" || !SESSION_ID_RE.test(currentSessionId)) {
    data[fileKey]["sessionId"] = safeSessionId;
  }
}

export function ensureSessionLevels(
  sessionKey: string,
  reasoningLevel: string,
  thinkingLevel: string,
  historyDir?: string,
): void {
  setSessionSettings(sessionKey, { reasoningLevel, thinkingLevel }, historyDir);
}

export interface FridaySessionSettings {
  reasoningLevel?: string;
  thinkingLevel?: string;
  modelRef?: string;
  providerOverride?: string;
  modelOverride?: string;
}

/**
 * Update shape for {@link setSessionSettings}. A field set to a string writes that value, a field
 * left `undefined` is untouched, and a field set to `null` **clears** the stored value. The `null`
 * case is what lets the app reset a model override back to the agent default — without it the merge
 * could only ever add/replace overrides, never remove them (the cause of "selecting the default
 * model doesn't take effect": a prior `provider/model` override survived and was read back).
 */
export type FridaySessionSettingsUpdate = {
  reasoningLevel?: string | null;
  thinkingLevel?: string | null;
  modelRef?: string | null;
  providerOverride?: string | null;
  modelOverride?: string | null;
};

export function setSessionSettings(
  sessionKey: string,
  settings: FridaySessionSettingsUpdate,
  historyDir?: string,
): FridaySessionSettings {
  try {
    const fileKey = toSessionStoreKey(sessionKey);
    const sessionsFile = resolveSessionsFilePath(historyDir, agentIdFromSessionKey(fileKey));
    const data = readSessionsData(sessionsFile);
    if (!data) return {};

    upsertSessionEntry(data, fileKey, sessionKey);

    const fieldKeys: (keyof FridaySessionSettingsUpdate)[] = [
      "reasoningLevel", "thinkingLevel", "modelRef", "providerOverride", "modelOverride",
    ];
    let updated = false;
    for (const key of fieldKeys) {
      const value = settings[key];
      if (value === undefined) continue; // leave the stored value untouched
      if (value === null) {
        // Explicit clear — remove the override so the agent falls back to its default.
        if (key in data[fileKey]) {
          delete data[fileKey][key];
          updated = true;
        }
        continue;
      }
      if (data[fileKey][key] !== value) {
        data[fileKey][key] = value;
        updated = true;
      }
    }

    if (updated) {
      writeSessionsData(sessionsFile, data);
    }

    return readSettingsFromEntry(data[fileKey]);
  } catch {
    return {};
  }
}

function readSettingsFromEntry(entry: Record<string, unknown>): FridaySessionSettings {
  const provider = typeof entry["providerOverride"] === "string" ? entry["providerOverride"] : undefined;
  const model = typeof entry["modelOverride"] === "string" ? entry["modelOverride"] : undefined;
  const storedModelRef = typeof entry["modelRef"] === "string" ? entry["modelRef"] : undefined;
  const modelRef = storedModelRef ?? (provider && model ? `${provider}/${model}` : undefined);

  return {
    reasoningLevel: typeof entry["reasoningLevel"] === "string" ? entry["reasoningLevel"] : undefined,
    thinkingLevel: typeof entry["thinkingLevel"] === "string" ? entry["thinkingLevel"] : undefined,
    modelRef,
  };
}

export function getSessionSettings(
  sessionKey: string,
  historyDir?: string,
): FridaySessionSettings {
  try {
    const fileKey = toSessionStoreKey(sessionKey);
    const sessionsFile = resolveSessionsFilePath(historyDir, agentIdFromSessionKey(fileKey));
    const data = readSessionsData(sessionsFile);
    if (!data) return {};

    const entry = data[fileKey];
    if (!entry) return {};
    return readSettingsFromEntry(entry);
  } catch {
    return {};
  }
}

/**
 * Resolve the configured default model + thinking level for the agent that owns `sessionKey`,
 * reading the live OpenClaw config. Prefers the target agent's own `model`/`thinkingDefault` over
 * the global `agents.defaults`, so non-main agents aren't silently forced onto the global default.
 *
 * Used to write the default model as an **explicit** override when the app selects it (the app
 * sends no modelRef for the default). Writing it explicitly — rather than clearing the stored
 * override — keeps the shared session entry consistent with the core's provenance fields
 * (`modelOverrideSource`, `model`, `modelProvider`); a bare clear leaves those dangling and the
 * agent mis-resolves to a fallback model.
 */
export function resolveAgentDefaults(sessionKey: string): { model?: string; thinking?: string } {
  try {
    const forwardRt = getFridayAgentForwardRuntime();
    if (!forwardRt) return {};
    const ocCfg = (forwardRt.getConfig() ?? {}) as Record<string, unknown>;
    const agents = ocCfg.agents as Record<string, unknown> | undefined;
    const targetAgentId = agentIdFromSessionKey(sessionKey);

    const agentEntry = (agents?.list as Array<Record<string, unknown>> | undefined)?.find(
      (a) => agentIdFromSessionKey(`agent:${typeof a?.id === "string" ? a.id : ""}:x`) === targetAgentId,
    );
    const agentModel = agentEntry?.model;
    const perAgentModel =
      typeof agentModel === "string"
        ? agentModel
        : typeof (agentModel as Record<string, unknown> | undefined)?.primary === "string"
          ? ((agentModel as Record<string, unknown>).primary as string)
          : undefined;
    const perAgentThinking =
      typeof agentEntry?.thinkingDefault === "string" ? (agentEntry.thinkingDefault) : undefined;

    const agentDefaults = agents?.defaults as Record<string, unknown> | undefined;
    const model = agentDefaults?.model as Record<string, unknown> | undefined;
    const globalModel = typeof model?.primary === "string" ? (model.primary) : undefined;
    const globalThinking =
      typeof agentDefaults?.thinkingDefault === "string" ? (agentDefaults.thinkingDefault) : undefined;

    return { model: perAgentModel ?? globalModel, thinking: perAgentThinking ?? globalThinking };
  } catch {
    // Config not available (e.g. unit tests) — caller decides the fallback.
    return {};
  }
}
