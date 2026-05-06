import { join } from "node:path";
import os from "node:os";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

const FRIDAY_AGENT_ID = "main";
const SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

function deriveOpenClawBaseDir(historyDir?: string): string {
  if (historyDir) {
    const match = historyDir.replace(/\/+$/, "").match(/(.*\/\.openclaw)\//);
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

export function resolveSessionsDir(historyDir?: string): string {
  const base = deriveOpenClawBaseDir(historyDir);
  return join(base, "agents/main/sessions");
}

export interface DeleteSessionResult {
  sessionKey: string;
  sessionId?: string;
  transcriptDeleted?: boolean;
}

export function deleteFridaySession(
  sessionKey: string,
  historyDir?: string,
): DeleteSessionResult {
  const result: DeleteSessionResult = { sessionKey };
  const sessionsFile = resolveSessionsFilePath(historyDir);
  const data = readSessionsData(sessionsFile);
  if (!data) return result;

  const fileKey = toSessionStoreKey(sessionKey);
  const entry = data[fileKey];
  if (!entry) return result;

  const sessionId = typeof entry["sessionId"] === "string" ? entry["sessionId"] : undefined;
  const sessionFilePath = typeof entry["sessionFile"] === "string" ? entry["sessionFile"] : undefined;
  result.sessionId = sessionId;

  if (sessionFilePath) {
    try { unlinkSync(sessionFilePath); result.transcriptDeleted = true; } catch { /* gone already */ }
  }

  if (sessionId) {
    const dir = resolveSessionsDir(historyDir);
    for (const suffix of [".trajectory.jsonl", ".trajectory-path.json"]) {
      try { unlinkSync(join(dir, `${sessionId}${suffix}`)); } catch { /* optional */ }
    }
  }

  delete data[fileKey];
  writeSessionsData(sessionsFile, data);
  return result;
}

export interface FridaySessionSettings {
  reasoningLevel?: string;
  thinkingLevel?: string;
  modelRef?: string;
  providerOverride?: string;
  modelOverride?: string;
}

export function setSessionSettings(
  sessionKey: string,
  settings: FridaySessionSettings,
  historyDir?: string,
): FridaySessionSettings {
  try {
    const sessionsFile = resolveSessionsFilePath(historyDir);
    const data = readSessionsData(sessionsFile);
    if (!data) return {};

    const fileKey = toSessionStoreKey(sessionKey);
    upsertSessionEntry(data, fileKey, sessionKey);

    const fieldKeys: (keyof FridaySessionSettings)[] = [
      "reasoningLevel", "thinkingLevel", "modelRef", "providerOverride", "modelOverride",
    ];
    let updated = false;
    for (const key of fieldKeys) {
      const value = settings[key];
      if (value !== undefined && data[fileKey][key] !== value) {
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
    const sessionsFile = resolveSessionsFilePath(historyDir);
    const data = readSessionsData(sessionsFile);
    if (!data) return {};

    const fileKey = toSessionStoreKey(sessionKey);
    const entry = data[fileKey];
    if (!entry) return {};
    return readSettingsFromEntry(entry);
  } catch {
    return {};
  }
}
