/**
 * Reads a session's transcript directly from disk via the forward runtime's
 * session store (`sessions.json` → entry.sessionFile → the `.jsonl` transcript).
 *
 * We do NOT use `runtime.subagent.getSessionMessages` here: that dispatches the
 * gateway `sessions.get` method which is only valid inside a gateway request
 * scope and returns empty when called from a plugin HTTP route. Reading the
 * transcript file mirrors how `history-sessions.ts` reads `sessions.json`.
 *
 * Each transcript line is `{type, id, parentId, timestamp, message:{role,content,...}}`.
 * We surface message records (in file order) with an `__openclaw` envelope
 * matching the gateway's own `sessions.get` output, so `normalize-message.ts`
 * can consume either source identically.
 */

import fs from "node:fs";
import path from "node:path";
import { getFridayAgentForwardRuntime } from "../agent-forward-runtime.js";
import { agentIdFromSessionKey, toSessionStoreKey } from "../session/session-manager.js";

function entryString(entry: unknown, key: string): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const v = (entry as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

/**
 * Resolves the store entry for a session key, tolerating case differences
 * (the app's key carries an upper-case deviceId; `sessions.json` stores it
 * lower-cased).
 */
function resolveEntry(store: Record<string, unknown>, sessionKey: string): unknown {
  if (store[sessionKey]) return store[sessionKey];
  const canonical = toSessionStoreKey(sessionKey);
  if (store[canonical]) return store[canonical];
  const target = canonical.toLowerCase();
  for (const [k, v] of Object.entries(store)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

export function resolveTranscriptPath(
  entry: unknown,
  storePath: string,
): string | undefined {
  const sessionFile = entryString(entry, "sessionFile");
  if (sessionFile) {
    return path.isAbsolute(sessionFile)
      ? sessionFile
      : path.join(path.dirname(storePath), sessionFile);
  }
  const sessionId = entryString(entry, "sessionId");
  if (sessionId) {
    return path.join(path.dirname(storePath), `${sessionId}.jsonl`);
  }
  return undefined;
}

/** Resolves the real server-side session id for a session key, or undefined. */
export function resolveSessionId(sessionKey: string): string | undefined {
  const rt = getFridayAgentForwardRuntime();
  if (!rt) return undefined;
  const agentId = agentIdFromSessionKey(sessionKey);
  try {
    const store = rt.loadSessionStore(rt.resolveStorePath(undefined, { agentId })) ?? {};
    return entryString(resolveEntry(store, sessionKey), "sessionId");
  } catch {
    return undefined;
  }
}

/**
 * Returns raw transcript message objects (newest tail up to `limit`), each with
 * an `__openclaw: { id, seq, recordTimestampMs }` envelope. Empty on any failure.
 */
export function readSessionTranscriptRawMessages(sessionKey: string, limit: number): unknown[] {
  const rt = getFridayAgentForwardRuntime();
  if (!rt) return [];

  const agentId = agentIdFromSessionKey(sessionKey);
  let storePath: string;
  let store: Record<string, unknown>;
  try {
    storePath = rt.resolveStorePath(undefined, { agentId });
    store = rt.loadSessionStore(storePath) ?? {};
  } catch {
    return [];
  }

  const entry = resolveEntry(store, sessionKey);
  if (!entry) return [];
  const filePath = resolveTranscriptPath(entry, storePath);
  if (!filePath) return [];

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const raw: unknown[] = [];
  let seq = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      rec = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.type === "session" || !rec.message || typeof rec.message !== "object") continue;
    seq += 1;
    const tsRaw = rec.timestamp;
    const ts =
      typeof tsRaw === "string"
        ? Date.parse(tsRaw)
        : typeof tsRaw === "number"
          ? tsRaw
          : Number.NaN;
    raw.push({
      ...(rec.message as Record<string, unknown>),
      __openclaw: {
        ...(typeof rec.id === "string" ? { id: rec.id } : {}),
        seq,
        ...(Number.isFinite(ts) ? { recordTimestampMs: ts } : {}),
      },
    });
  }

  return limit > 0 && raw.length > limit ? raw.slice(raw.length - limit) : raw;
}
