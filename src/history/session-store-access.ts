/**
 * Session-row access that understands both host stores:
 *
 *   - OpenClaw ≥2026.8.1: `listSessionEntries` / `getSessionEntry` (SQLite).
 *   - Older hosts: `loadSessionStore` over `sessions.json`.
 *
 * COMPAT(openclaw<2026.8.1) — the JSON-map path. `minHostVersion` stays on the
 * older floor. Grep this tag when no install still ships `sessions.json`.
 */

import { getFridayAgentForwardRuntime } from "../agent-forward-runtime.js";
import { agentIdFromSessionKey, toSessionStoreKey } from "../session/session-manager.js";

export type SessionStoreRow = {
  sessionKey: string;
  entry: Record<string, unknown>;
  /**
   * True when the row came from the legacy whole-store JSON map. Missing /
   * empty transcript files then mean "archived". SQLite rows must NOT use this
   * — `sessionFile` is null or a `sqlite:` marker, not a live JSONL path.
   */
  requireTranscriptFile: boolean;
};

function isEntryRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function uniqueKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    const trimmed = key.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Every session row for one agent. Prefers the identity list (SQLite) so a
 * missing `sessions.json` does not yield an empty sidebar.
 */
export function listSessionStoreRows(agentId: string): SessionStoreRow[] {
  const rt = getFridayAgentForwardRuntime();
  if (!rt) return [];

  if (typeof rt.listSessionEntries === "function") {
    try {
      const listed = rt.listSessionEntries({ agentId, readOnly: true }) ?? [];
      return listed.flatMap((row) => {
        if (!row || typeof row.sessionKey !== "string" || !isEntryRecord(row.entry)) return [];
        return [
          {
            sessionKey: row.sessionKey,
            entry: row.entry,
            requireTranscriptFile: false,
          },
        ];
      });
    } catch {
      // COMPAT(openclaw<2026.8.1): fall through to the JSON map.
    }
  }

  if (typeof rt.loadSessionStore !== "function") return [];
  try {
    const storePath = rt.resolveStorePath(undefined, { agentId });
    const store = rt.loadSessionStore(storePath) ?? {};
    const rows: SessionStoreRow[] = [];
    for (const [sessionKey, raw] of Object.entries(store)) {
      if (!isEntryRecord(raw)) continue;
      rows.push({ sessionKey, entry: raw, requireTranscriptFile: true });
    }
    return rows;
  } catch {
    return [];
  }
}

/** Resolve one session by key, tolerating deviceId case differences. */
export function findSessionStoreRow(sessionKey: string): SessionStoreRow | undefined {
  const rt = getFridayAgentForwardRuntime();
  if (!rt) return undefined;
  const fileKey = toSessionStoreKey(sessionKey);
  const agentId = agentIdFromSessionKey(fileKey);
  const candidates = uniqueKeys([sessionKey, fileKey]);

  if (typeof rt.getSessionEntry === "function") {
    for (const key of candidates) {
      try {
        const entry = rt.getSessionEntry({ sessionKey: key, agentId });
        if (isEntryRecord(entry)) {
          return { sessionKey: key, entry, requireTranscriptFile: false };
        }
      } catch {
        // Keep looking; a bad candidate must not hide a later match.
      }
    }
  }

  const listed = listSessionStoreRows(agentId);
  const targets = new Set(candidates.map((k) => k.toLowerCase()));
  for (const row of listed) {
    if (targets.has(row.sessionKey.toLowerCase())) return row;
  }
  return undefined;
}
