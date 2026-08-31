/**
 * Reads a session's transcript.
 *
 * OpenClaw 2026.8.1+ stores events in SQLite (`loadTranscriptEventsSync` by
 * `{agentId, sessionId}`). Older hosts keep `sessions.json` → `entry.sessionFile`
 * → `.jsonl`. We do NOT use `runtime.subagent.getSessionMessages` as the primary
 * path: that dispatches gateway `sessions.get`, which is only valid inside a
 * gateway request scope and returns empty from a plugin HTTP route.
 *
 * Each record is `{type, id, parentId, timestamp, message:{role,content,...}}`.
 * Message records are surfaced (in order) with an `__openclaw` envelope matching
 * the gateway's `sessions.get` output so `normalize-message.ts` can consume either
 * source identically.
 *
 * COMPAT(openclaw<2026.8.1) — the JSONL file path.
 */

import fs from "node:fs";
import path from "node:path";
import { getFridayAgentForwardRuntime } from "../agent-forward-runtime.js";
import { agentIdFromSessionKey } from "../session/session-manager.js";
import { findSessionStoreRow } from "./session-store-access.js";

function entryString(entry: unknown, key: string): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const v = (entry as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** 2026.8.1 `loadSessionStore` projects this marker; it is not a filesystem path. */
export function isSqliteSessionFileMarker(sessionFile: string | undefined): boolean {
  return typeof sessionFile === "string" && sessionFile.startsWith("sqlite:");
}

export function resolveTranscriptPath(entry: unknown, storePath: string): string | undefined {
  const sessionFile = entryString(entry, "sessionFile");
  if (sessionFile) {
    if (isSqliteSessionFileMarker(sessionFile)) return undefined;
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

/**
 * Archived/empty on the JSONL store means the transcript file is gone. SQLite
 * rows have no live file (`sessionFile` null or a `sqlite:` marker) — drop only
 * when `archivedAt` is set.
 */
export function hasLiveTranscript(
  entry: Record<string, unknown>,
  storePath: string,
  requireTranscriptFile: boolean,
): boolean {
  if (typeof entry.archivedAt === "number" && Number.isFinite(entry.archivedAt)) return false;
  const sessionFile = entryString(entry, "sessionFile");
  if (isSqliteSessionFileMarker(sessionFile)) return true;
  if (!requireTranscriptFile) return true;
  const filePath = resolveTranscriptPath(entry, storePath);
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function recordsFromJsonlFile(filePath: string, maxBytes?: number): unknown[] {
  let content: string;
  try {
    if (maxBytes !== undefined) {
      const fd = fs.openSync(filePath, "r");
      try {
        const size = fs.fstatSync(fd).size;
        const toRead = Math.min(size, maxBytes);
        const buf = Buffer.allocUnsafe(toRead);
        const bytes = fs.readSync(fd, buf, 0, toRead, 0);
        content = buf.toString("utf-8", 0, bytes);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      content = fs.readFileSync(filePath, "utf-8");
    }
  } catch {
    return [];
  }
  const records: unknown[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) records.push(parsed);
    } catch {
      continue;
    }
  }
  return records;
}

export type TranscriptReadScope = {
  entry: Record<string, unknown>;
  sessionKey: string;
  agentId?: string;
  storePath?: string;
  /** Cap JSONL bytes (cron title scan). Ignored for SQLite event loads. */
  maxBytes?: number;
};

/**
 * Transcript records in storage order. SQLite first when the host exposes
 * `loadTranscriptEventsSync`; otherwise the JSONL file.
 */
export function readTranscriptRecords(scope: TranscriptReadScope): unknown[] {
  const sessionId = entryString(scope.entry, "sessionId");
  const rt = getFridayAgentForwardRuntime();
  if (sessionId && typeof rt?.loadTranscriptEventsSync === "function") {
    try {
      const events = rt.loadTranscriptEventsSync({
        sessionId,
        sessionKey: scope.sessionKey,
        ...(scope.agentId ? { agentId: scope.agentId } : {}),
        ...(scope.storePath ? { storePath: scope.storePath } : {}),
      });
      if (Array.isArray(events) && events.length > 0) return events;
    } catch {
      // Fall through to JSONL (COMPAT / incomplete SQLite bind).
    }
  }

  if (!scope.storePath) return [];
  const filePath = resolveTranscriptPath(scope.entry, scope.storePath);
  if (!filePath) return [];
  return recordsFromJsonlFile(filePath, scope.maxBytes);
}

/** Resolves the real server-side session id for a session key, or undefined. */
export function resolveSessionId(sessionKey: string): string | undefined {
  return entryString(findSessionStoreRow(sessionKey)?.entry, "sessionId");
}

export function transcriptRecordsToRawMessages(records: unknown[], limit: number): unknown[] {
  const raw: unknown[] = [];
  let seq = 0;
  for (const recUnknown of records) {
    if (!recUnknown || typeof recUnknown !== "object" || Array.isArray(recUnknown)) continue;
    const rec = recUnknown as Record<string, unknown>;
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

/**
 * Returns raw transcript message objects (newest tail up to `limit`), each with
 * an `__openclaw: { id, seq, recordTimestampMs }` envelope. Empty on any failure.
 */
export function readSessionTranscriptRawMessages(sessionKey: string, limit: number): unknown[] {
  const row = findSessionStoreRow(sessionKey);
  if (!row) return [];
  const rt = getFridayAgentForwardRuntime();
  let storePath: string | undefined;
  try {
    storePath = rt?.resolveStorePath(undefined, {
      agentId: agentIdFromSessionKey(row.sessionKey),
    });
  } catch {
    storePath = undefined;
  }
  const records = readTranscriptRecords({
    entry: row.entry,
    sessionKey: row.sessionKey,
    agentId: agentIdFromSessionKey(row.sessionKey),
    storePath,
  });
  return transcriptRecordsToRawMessages(records, limit);
}
