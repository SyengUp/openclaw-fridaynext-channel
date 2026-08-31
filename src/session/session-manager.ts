import { join } from "node:path";
import os from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { getFridayAgentForwardRuntime } from "../agent-forward-runtime.js";
import { findAgentRosterConfig } from "../agent-roster.js";
import { createFridayNextLogger } from "../logging.js";

const log = createFridayNextLogger("session");

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

export const SESSION_PERMISSION_MODES = ["read-only", "guarded", "workspace", "full"] as const;
export type SessionPermissionMode = (typeof SESSION_PERMISSION_MODES)[number];

export function isSessionPermissionMode(value: unknown): value is SessionPermissionMode {
  return (
    typeof value === "string" &&
    (SESSION_PERMISSION_MODES as readonly string[]).includes(value)
  );
}

const EXEC_MODE_TO_PERMISSION: Record<string, SessionPermissionMode> = {
  deny: "read-only",
  ask: "guarded",
  auto: "workspace",
  full: "full",
};

function readNestedString(obj: unknown, path: string[]): string | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" && cur.trim() ? cur.trim() : undefined;
}

/**
 * Display-only mapping of configured exec policy → session permission label.
 * Omits `allowlist` and any agent whose sandbox is not `off`, matching Control UI:
 * those cases cannot be stated truthfully at agent scope.
 */
export function resolveDefaultPermissionMode(
  cfg: unknown,
  agentConfig?: Record<string, unknown>,
): SessionPermissionMode | undefined {
  const sandbox =
    readNestedString(agentConfig, ["sandbox", "mode"]) ??
    readNestedString(cfg, ["agents", "defaults", "sandbox", "mode"]) ??
    readNestedString(cfg, ["sandbox", "mode"]);
  if (sandbox && sandbox !== "off") return undefined;

  const execMode =
    readNestedString(agentConfig, ["tools", "exec", "mode"]) ??
    readNestedString(cfg, ["agents", "defaults", "tools", "exec", "mode"]) ??
    readNestedString(cfg, ["tools", "exec", "mode"]);
  if (!execMode || execMode === "allowlist") return undefined;
  return EXEC_MODE_TO_PERMISSION[execMode];
}

export async function ensureSessionLevels(
  sessionKey: string,
  reasoningLevel: string,
  thinkingLevel: string,
  historyDir?: string,
): Promise<void> {
  await setSessionSettings(sessionKey, { reasoningLevel, thinkingLevel }, historyDir);
}

export interface FridaySessionSettings {
  reasoningLevel?: string;
  thinkingLevel?: string;
  modelRef?: string;
  providerOverride?: string;
  modelOverride?: string;
  permissionMode?: SessionPermissionMode;
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
  permissionMode?: SessionPermissionMode | null;
};

export async function setSessionSettings(
  sessionKey: string,
  settings: FridaySessionSettingsUpdate,
  historyDir?: string,
): Promise<FridaySessionSettings> {
  // COMPAT(openclaw<2026.8.1): sessions.json still exists on older hosts.
  const jsonResult = writeJsonSessionSettings(sessionKey, settings, historyDir);
  await writeSdkSessionSettings(sessionKey, settings);
  return overlaySdkSessionSettings(sessionKey, jsonResult);
}

function writeJsonSessionSettings(
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
      "reasoningLevel",
      "thinkingLevel",
      "modelRef",
      "providerOverride",
      "modelOverride",
      "permissionMode",
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
  const provider =
    typeof entry["providerOverride"] === "string" ? entry["providerOverride"] : undefined;
  const model = typeof entry["modelOverride"] === "string" ? entry["modelOverride"] : undefined;
  const storedModelRef = typeof entry["modelRef"] === "string" ? entry["modelRef"] : undefined;
  const modelRef = storedModelRef ?? (provider && model ? `${provider}/${model}` : undefined);

  return {
    reasoningLevel:
      typeof entry["reasoningLevel"] === "string" ? entry["reasoningLevel"] : undefined,
    thinkingLevel: typeof entry["thinkingLevel"] === "string" ? entry["thinkingLevel"] : undefined,
    modelRef,
    permissionMode: isSessionPermissionMode(entry["permissionMode"])
      ? entry["permissionMode"]
      : undefined,
  };
}

function readSdkSessionEntry(sessionKey: string): Record<string, unknown> | undefined {
  try {
    const rt = getFridayAgentForwardRuntime();
    if (!rt?.getSessionEntry) return undefined;
    const resolved = resolveCanonicalSessionTarget(sessionKey);
    if (!resolved) return undefined;
    return (
      rt.getSessionEntry({ sessionKey: resolved.sessionKey, agentId: resolved.agentId }) ??
      rt.getSessionEntry({ sessionKey, agentId: resolved.agentId })
    );
  } catch {
    return undefined;
  }
}

/**
 * SQLite (8.1+) is canonical for every session field the agent actually reads.
 * JSON is a fallback for older hosts and for fields the identity row has not
 * stored yet. `permissionMode` still treats a present SDK row as authoritative
 * even when the field is missing (Default), matching Control UI.
 */
function overlaySdkSessionSettings(
  sessionKey: string,
  json: FridaySessionSettings,
): FridaySessionSettings {
  const sdkEntry = readSdkSessionEntry(sessionKey);
  if (!sdkEntry) return json;
  const fromSdk = readSettingsFromEntry(sdkEntry);
  return {
    reasoningLevel: fromSdk.reasoningLevel ?? json.reasoningLevel,
    thinkingLevel: fromSdk.thinkingLevel ?? json.thinkingLevel,
    modelRef: fromSdk.modelRef ?? json.modelRef,
    permissionMode: isSessionPermissionMode(sdkEntry["permissionMode"])
      ? sdkEntry["permissionMode"]
      : undefined,
  };
}

function sessionRestOf(canonicalKey: string): string | undefined {
  return canonicalKey.match(/^agent:[^:]+:(.+)$/)?.[1];
}

/**
 * Find the store key Control UI / the agent actually use. `toSessionStoreKey` lowercases and
 * may rewrite the id; the SQLite row might still be the original key, or keyed by a
 * `friday:direct:…` id whose `sessionId` is the short Control UI id (e.g. `mth7v8za`).
 */
function resolveCanonicalSessionTarget(
  sessionKey: string,
): { sessionKey: string; agentId: string } | undefined {
  const rt = getFridayAgentForwardRuntime();
  if (!rt) return undefined;
  const fileKey = toSessionStoreKey(sessionKey);
  const agentId = agentIdFromSessionKey(fileKey);
  const candidates = [fileKey, sessionKey].filter((k, i, arr) => arr.indexOf(k) === i);

  for (const key of candidates) {
    try {
      if (rt.getSessionEntry?.({ sessionKey: key, agentId })) {
        return { sessionKey: key, agentId };
      }
    } catch {
      // Keep looking; a bad candidate must not hide a later match.
    }
  }

  const rest = sessionRestOf(fileKey);
  const rawRest = sessionRestOf(toSessionStoreKey(sessionKey)) ?? sessionKey.trim();
  const ids = new Set(
    [rest, rawRest, sessionKey.trim()].filter((id) => id && SESSION_ID_RE.test(id)),
  );
  try {
    const listed = rt.listSessionEntries?.({ agentId }) ?? [];
    for (const row of listed) {
      if (candidates.some((k) => k.toLowerCase() === row.sessionKey.toLowerCase())) {
        return { sessionKey: row.sessionKey, agentId };
      }
    }
    for (const row of listed) {
      const sessionId =
        typeof row.entry?.sessionId === "string" ? row.entry.sessionId : undefined;
      if (sessionId && ids.has(sessionId)) {
        return { sessionKey: row.sessionKey, agentId };
      }
      // `agent:main:fridaynext:mth7v8za` is the store key; Control UI / users quote `mth7v8za`.
      const lastSeg = row.sessionKey.split(":").pop();
      if (lastSeg && ids.has(lastSeg)) {
        return { sessionKey: row.sessionKey, agentId };
      }
    }
  } catch {
    // list is best-effort
  }

  return { sessionKey: fileKey, agentId };
}

const SDK_SESSION_SETTING_KEYS: (keyof FridaySessionSettingsUpdate)[] = [
  "reasoningLevel",
  "thinkingLevel",
  "modelRef",
  "providerOverride",
  "modelOverride",
  "permissionMode",
];

function sessionSettingsSdkPatch(
  settings: FridaySessionSettingsUpdate,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  for (const key of SDK_SESSION_SETTING_KEYS) {
    const value = settings[key];
    if (value === undefined) continue;
    patch[key] = value;
  }
  if (
    settings.modelOverride !== undefined ||
    settings.providerOverride !== undefined ||
    settings.modelRef !== undefined
  ) {
    const clearing = settings.modelOverride === null || settings.modelRef === null;
    patch.modelOverrideSource = clearing ? null : "user";
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function sdkSessionSettingsMatch(
  entry: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
): boolean {
  if (!entry) return false;
  for (const [key, expected] of Object.entries(patch)) {
    const actual = entry[key];
    if (expected === null) {
      if (actual != null) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

async function writeSdkSessionSettings(
  sessionKey: string,
  settings: FridaySessionSettingsUpdate,
): Promise<void> {
  const patchBody = sessionSettingsSdkPatch(settings);
  if (!patchBody) return;
  const rt = getFridayAgentForwardRuntime();
  if (!rt) return;
  const target = resolveCanonicalSessionTarget(sessionKey);
  if (!target) return;
  const patch = () => patchBody;

  try {
    if (rt.patchSessionEntry) {
      const updated = await rt.patchSessionEntry({
        sessionKey: target.sessionKey,
        agentId: target.agentId,
        preserveActivity: true,
        update: patch,
      });
      if (sdkSessionSettingsMatch(updated, patchBody)) return;
      log.warn(
        `patchSessionEntry did not persist session settings key=${target.sessionKey}`,
      );
    }
  } catch (err) {
    log.warn(
      `patchSessionEntry failed for ${target.sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!rt.updateSessionStoreEntry) return;
  try {
    const storePath = rt.resolveStorePath(undefined, { agentId: target.agentId });
    const load = rt.loadSessionStore;
    const store = typeof load === "function" ? (load(storePath) ?? {}) : {};
    const storeKey =
      store[target.sessionKey] !== undefined
        ? target.sessionKey
        : store[sessionKey] !== undefined
          ? sessionKey
          : Object.keys(store).find((k) => k.toLowerCase() === target.sessionKey.toLowerCase()) ??
            target.sessionKey;
    const updated = await rt.updateSessionStoreEntry({
      storePath,
      sessionKey: storeKey,
      update: patch,
    });
    if (!sdkSessionSettingsMatch(updated, patchBody)) {
      log.warn(`updateSessionStoreEntry did not persist session settings key=${storeKey}`);
    }
  } catch (err) {
    log.warn(
      `updateSessionStoreEntry failed for ${target.sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function getSessionSettings(sessionKey: string, historyDir?: string): FridaySessionSettings {
  try {
    const fileKey = toSessionStoreKey(sessionKey);
    const sessionsFile = resolveSessionsFilePath(historyDir, agentIdFromSessionKey(fileKey));
    const data = readSessionsData(sessionsFile);
    const json = data?.[fileKey] ? readSettingsFromEntry(data[fileKey]) : {};
    return overlaySdkSessionSettings(sessionKey, json);
  } catch {
    return overlaySdkSessionSettings(sessionKey, {});
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

    const agentEntry = findAgentRosterConfig(ocCfg, targetAgentId);
    const agentModel = agentEntry?.model;
    const perAgentModel =
      typeof agentModel === "string"
        ? agentModel
        : typeof (agentModel as Record<string, unknown> | undefined)?.primary === "string"
          ? ((agentModel as Record<string, unknown>).primary as string)
          : undefined;
    const perAgentThinking =
      typeof agentEntry?.thinkingDefault === "string" ? agentEntry.thinkingDefault : undefined;

    const agentDefaults = agents?.defaults as Record<string, unknown> | undefined;
    const model = agentDefaults?.model as Record<string, unknown> | undefined;
    const globalModel = typeof model?.primary === "string" ? model.primary : undefined;
    const globalThinking =
      typeof agentDefaults?.thinkingDefault === "string"
        ? agentDefaults.thinkingDefault
        : undefined;

    return { model: perAgentModel ?? globalModel, thinking: perAgentThinking ?? globalThinking };
  } catch {
    // Config not available (e.g. unit tests) — caller decides the fallback.
    return {};
  }
}
