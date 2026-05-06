/**
 * Session bookkeeping for the Friday Next channel: sessions.json updates
 * for reasoning/thinking levels.
 */

import { join } from "node:path";
import os from "node:os";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

const FRIDAY_AGENT_ID = "main";
const SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

function normalizeLowercaseStringOrEmpty(value: string): string {
  return value.trim().toLowerCase();
}

function deriveOpenClawBaseDir(historyDir?: string): string {
  if (historyDir) {
    const match = historyDir.replace(/\/+$/, "").match(/(.*\/\.openclaw)\//);
    if (match?.[1]) return match[1];
  }
  return join(os.homedir(), ".openclaw");
}

/**
 * Mirror OpenClaw `toAgentStoreSessionKey({ agentId: "main", requestKey })` so
 * `sessions.json` and inbound dispatch use the same store key as the gateway
 * (e.g. `default` → `agent:main:default`, `main` → `agent:main:main`).
 */
export function toSessionStoreKey(rawSessionKey: string): string {
  const raw = rawSessionKey.trim();
  const lowered = normalizeLowercaseStringOrEmpty(raw);
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
    if (c.startsWith(`agent:${FRIDAY_AGENT_ID}:`)) {
      const tail = c.slice(`agent:${FRIDAY_AGENT_ID}:`.length);
      if (SESSION_ID_RE.test(tail)) return tail;
      return toSafeSessionId(tail);
    }
  }
  return toSafeSessionId(rawSessionKey || fileKey);
}

function resolveSessionsFilePath(historyDir?: string): string {
  const base = deriveOpenClawBaseDir(historyDir);
  return join(base, "agents/main/sessions/sessions.json");
}

/**
 * Ensure a session has the desired reasoning/thinking level settings.
 * Creates the session entry if it doesn't exist.
 * Key matches the gateway's toAgentStoreSessionKey normalization.
 */
export function ensureSessionLevels(
  sessionKey: string,
  reasoningLevel: string,
  thinkingLevel: string,
  historyDir?: string,
): void {
  try {
    const sessionsFile = resolveSessionsFilePath(historyDir);
    if (!existsSync(sessionsFile)) return;

    const raw = readFileSync(sessionsFile, "utf-8");
    const data = JSON.parse(raw) as Record<string, Record<string, unknown>>;

    const fileKey = toSessionStoreKey(sessionKey);
    const safeSessionId = sessionIdForSessionsFile(fileKey, sessionKey);
    let updated = false;

    if (!data[fileKey]) {
      data[fileKey] = {
        sessionId: safeSessionId,
        updatedAt: Date.now(),
        systemSent: true,
      };
      updated = true;
    }

    const currentSessionId = data[fileKey]["sessionId"];
    if (typeof currentSessionId !== "string" || !SESSION_ID_RE.test(currentSessionId)) {
      data[fileKey]["sessionId"] = safeSessionId;
      updated = true;
    }

    if (data[fileKey]["reasoningLevel"] !== reasoningLevel) {
      data[fileKey]["reasoningLevel"] = reasoningLevel;
      updated = true;
    }

    if (data[fileKey]["thinkingLevel"] !== thinkingLevel) {
      data[fileKey]["thinkingLevel"] = thinkingLevel;
      updated = true;
    }

    if (updated) {
      writeFileSync(sessionsFile, JSON.stringify(data, null, 2), "utf-8");
    }
  } catch {
    // Silently ignore errors — session settings are best-effort
  }
}

export function resolveSessionsDir(historyDir?: string): string {
  const base = deriveOpenClawBaseDir(historyDir);
  return join(base, "agents/main/sessions");
}

export interface DeleteSessionResult {
  sessionKey: string;
  sessionId?: string;
  transcriptDeleted?: boolean;
}

/**
 * Delete a session entry from sessions.json and its transcript files.
 * Returns info about what was deleted.
 */
export function deleteFridaySession(
  sessionKey: string,
  historyDir?: string,
): DeleteSessionResult {
  const result: DeleteSessionResult = { sessionKey };
  const sessionsFile = resolveSessionsFilePath(historyDir);
  if (!existsSync(sessionsFile)) return result;

  const raw = readFileSync(sessionsFile, "utf-8");
  const data = JSON.parse(raw) as Record<string, Record<string, unknown>>;
  const fileKey = toSessionStoreKey(sessionKey);
  const entry = data[fileKey];
  if (!entry) return result;

  const sessionId = typeof entry["sessionId"] === "string" ? entry["sessionId"] : undefined;
  const sessionFilePath =
    typeof entry["sessionFile"] === "string" ? entry["sessionFile"] : undefined;
  result.sessionId = sessionId;

  // Delete transcript .jsonl file
  if (sessionFilePath) {
    try { unlinkSync(sessionFilePath); result.transcriptDeleted = true; } catch { /* gone already */ }
  }

  // Delete trajectory files
  if (sessionId) {
    const dir = resolveSessionsDir(historyDir);
    for (const suffix of [".trajectory.jsonl", ".trajectory-path.json"]) {
      try { unlinkSync(join(dir, `${sessionId}${suffix}`)); } catch { /* optional */ }
    }
  }

  // Remove from sessions.json
  delete data[fileKey];
  writeFileSync(sessionsFile, JSON.stringify(data, null, 2), "utf-8");

  return result;
}

export interface FridaySessionSettings {
  reasoningLevel?: string;
  thinkingLevel?: string;
  modelRef?: string;
  providerOverride?: string;
  modelOverride?: string;
}

/**
 * Set session-level settings (reasoning, thinking, model) in sessions.json.
 * Only updates the fields that are provided (non-undefined).
 */
export function setSessionSettings(
  sessionKey: string,
  settings: FridaySessionSettings,
  historyDir?: string,
): void {
  try {
    const sessionsFile = resolveSessionsFilePath(historyDir);
    if (!existsSync(sessionsFile)) return;

    const raw = readFileSync(sessionsFile, "utf-8");
    const data = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    const fileKey = toSessionStoreKey(sessionKey);
    const safeSessionId = sessionIdForSessionsFile(fileKey, sessionKey);
    let updated = false;

    if (!data[fileKey]) {
      data[fileKey] = {
        sessionId: safeSessionId,
        updatedAt: Date.now(),
        systemSent: true,
      };
      updated = true;
    }

    const currentSessionId = data[fileKey]["sessionId"];
    if (typeof currentSessionId !== "string" || !SESSION_ID_RE.test(currentSessionId)) {
      data[fileKey]["sessionId"] = safeSessionId;
      updated = true;
    }

    if (settings.reasoningLevel !== undefined && data[fileKey]["reasoningLevel"] !== settings.reasoningLevel) {
      data[fileKey]["reasoningLevel"] = settings.reasoningLevel;
      updated = true;
    }

    if (settings.thinkingLevel !== undefined && data[fileKey]["thinkingLevel"] !== settings.thinkingLevel) {
      data[fileKey]["thinkingLevel"] = settings.thinkingLevel;
      updated = true;
    }

    if (settings.modelRef !== undefined && data[fileKey]["modelRef"] !== settings.modelRef) {
      data[fileKey]["modelRef"] = settings.modelRef;
      updated = true;
    }

    if (settings.providerOverride !== undefined && data[fileKey]["providerOverride"] !== settings.providerOverride) {
      data[fileKey]["providerOverride"] = settings.providerOverride;
      updated = true;
    }

    if (settings.modelOverride !== undefined && data[fileKey]["modelOverride"] !== settings.modelOverride) {
      data[fileKey]["modelOverride"] = settings.modelOverride;
      updated = true;
    }

    if (updated) {
      writeFileSync(sessionsFile, JSON.stringify(data, null, 2), "utf-8");
    }
  } catch {
    // Silently ignore errors — session settings are best-effort
  }
}

/**
 * Read session-level settings from sessions.json.
 * Returns undefined for fields that aren't set.
 */
export function getSessionSettings(
  sessionKey: string,
  historyDir?: string,
): FridaySessionSettings {
  try {
    const sessionsFile = resolveSessionsFilePath(historyDir);
    if (!existsSync(sessionsFile)) return {};

    const raw = readFileSync(sessionsFile, "utf-8");
    const data = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    const fileKey = toSessionStoreKey(sessionKey);
    const entry = data[fileKey];
    if (!entry) return {};

    const provider = typeof entry["providerOverride"] === "string" ? entry["providerOverride"] : undefined;
    const model = typeof entry["modelOverride"] === "string" ? entry["modelOverride"] : undefined;
    const storedModelRef = typeof entry["modelRef"] === "string" ? entry["modelRef"] : undefined;
    // Build modelRef from providerOverride/modelOverride if modelRef not explicitly stored
    const modelRef = storedModelRef ?? (provider && model ? `${provider}/${model}` : undefined);

    return {
      reasoningLevel: typeof entry["reasoningLevel"] === "string" ? entry["reasoningLevel"] : undefined,
      thinkingLevel: typeof entry["thinkingLevel"] === "string" ? entry["thinkingLevel"] : undefined,
      modelRef,
    };
  } catch {
    return {};
  }
}
