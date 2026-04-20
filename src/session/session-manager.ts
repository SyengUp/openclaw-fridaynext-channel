/**
 * Session bookkeeping for the Friday channel (device activity) and
 * sessions.json updates for reasoning/thinking levels.
 */

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const FRIDAY_AGENT_ID = "main";
const SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

/**
 * Mirror the gateway's session key canonicalization so we write to the same
 * key that initSessionState will read from sessions.json.
 *
 * The gateway uses canonicalizeMainSessionAlias which:
 * - For bare keys (e.g. "test-session"): returns them unchanged
 * - For "main" or alias keys: returns "agent:main:main"
 * - For keys already prefixed with "agent:": returns them unchanged
 *
 * This means for normal session keys, we write the bare key.
 * For the special "main" alias, we write "agent:main:main".
 */
/** Public: must match gateway session key used in `sessions.json`. */
export function toSessionStoreKey(rawSessionKey: string): string {
  const raw = rawSessionKey.trim();
  const lower = raw.toLowerCase();
  if (lower === "main") {
    return `agent:${FRIDAY_AGENT_ID}:main`;
  }
  return raw;
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

/**
 * sessions.json stores `sessionId` as an OpenClaw-valid id (no colons).
 * Keep inbound SessionKey passthrough unchanged; only sanitize this file field.
 */
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

export interface FridaySessionInfo {
  deviceId: string;
  createdAt: number;
  lastActivityAt: number;
}

const sessions = new Map<string, FridaySessionInfo>();

/** Record or refresh activity for a device (SSE connect). */
export function createFridaySession(deviceId: string): FridaySessionInfo {
  const existing = sessions.get(deviceId);
  if (existing) {
    existing.lastActivityAt = Date.now();
    return existing;
  }
  const info: FridaySessionInfo = {
    deviceId,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
  sessions.set(deviceId, info);
  return info;
}

/** Path to the sessions.json file */
const SESSIONS_FILE = join(
  process.env.HOME ?? "/Users/syengup",
  ".openclaw/agents/main/sessions/sessions.json",
);

/**
 * Ensure a session has the desired reasoning/thinking level settings.
 * Creates the session entry if it doesn't exist.
 * Key matches the gateway's toAgentStoreSessionKey normalization.
 */
export function ensureSessionLevels(
  sessionKey: string,
  reasoningLevel: string,
  thinkingLevel: string,
): void {
  try {
    if (!existsSync(SESSIONS_FILE)) return;

    const raw = readFileSync(SESSIONS_FILE, "utf-8");
    const sessionsFile = JSON.parse(raw) as Record<string, Record<string, unknown>>;

    const fileKey = toSessionStoreKey(sessionKey);
    const safeSessionId = sessionIdForSessionsFile(fileKey, sessionKey);
    let updated = false;

    if (!sessionsFile[fileKey]) {
      sessionsFile[fileKey] = {
        sessionId: safeSessionId,
        updatedAt: Date.now(),
        systemSent: true,
      };
      updated = true;
    }

    const currentSessionId = sessionsFile[fileKey]["sessionId"];
    if (typeof currentSessionId !== "string" || !SESSION_ID_RE.test(currentSessionId)) {
      sessionsFile[fileKey]["sessionId"] = safeSessionId;
      updated = true;
    }

    if (sessionsFile[fileKey]["reasoningLevel"] !== reasoningLevel) {
      sessionsFile[fileKey]["reasoningLevel"] = reasoningLevel;
      updated = true;
    }

    if (sessionsFile[fileKey]["thinkingLevel"] !== thinkingLevel) {
      sessionsFile[fileKey]["thinkingLevel"] = thinkingLevel;
      updated = true;
    }

    if (updated) {
      writeFileSync(SESSIONS_FILE, JSON.stringify(sessionsFile, null, 2), "utf-8");
    }
  } catch {
    // Silently ignore errors — session settings are best-effort
  }
}
