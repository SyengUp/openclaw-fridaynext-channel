/**
 * Reads a session's transcript.
 *
 * Current hosts expose `readSessionTranscriptEvents` by session identity.
 * Hosts before SQLite keep `sessions.json` → `entry.sessionFile`
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
import { agentIdFromSessionKey, toSessionStoreKey } from "../session/session-manager.js";
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

type TranscriptReadResult = {
  records: unknown[];
  /** Async host reads are final, including empty results and read failures. */
  authoritative: boolean;
};

/**
 * Transcript records in storage order. Prefer the async host reader; retain
 * JSONL reads only for supported hosts predating that API.
 */
export async function readTranscriptRecords(scope: TranscriptReadScope): Promise<TranscriptReadResult> {
  const sessionId = entryString(scope.entry, "sessionId");
  const rt = getFridayAgentForwardRuntime();
  if (rt?.readSessionTranscriptEvents) {
    if (!sessionId) return { records: [], authoritative: true };
    try {
      const records = await rt.readSessionTranscriptEvents({
        sessionId,
        sessionKey: scope.sessionKey,
        ...(scope.agentId ? { agentId: scope.agentId } : {}),
        ...(scope.storePath ? { storePath: scope.storePath } : {}),
      });
      return { records, authoritative: true };
    } catch {
      return { records: [], authoritative: true };
    }
  }

  if (!scope.storePath) return { records: [], authoritative: false };
  const filePath = resolveTranscriptPath(scope.entry, scope.storePath);
  if (!filePath) return { records: [], authoritative: false };
  return { records: recordsFromJsonlFile(filePath, scope.maxBytes), authoritative: false };
}

/** Resolves the real server-side session id for a session key, or undefined. */
export function resolveSessionId(sessionKey: string): string | undefined {
  return entryString(findSessionStoreRow(sessionKey)?.entry, "sessionId");
}

/**
 * Resolves the session's current display title (`displayName`, then `label`), or
 * undefined. This is the same source `/history/sessions` uses; exposing it on the
 * per-session endpoint lets the app heal a pending AI-title window on every sync,
 * even when the `session-title` push was lost.
 */
export function resolveSessionTitle(sessionKey: string): string | undefined {
  const entry = findSessionStoreRow(sessionKey)?.entry;
  return entryString(entry, "displayName") ?? entryString(entry, "label");
}

/**
 * Message records with their `__openclaw` envelope. `seq` is the GLOBAL position
 * over the full filtered transcript (1..N), so slices from different offset
 * pages still share one stable ordering key when the app concatenates them.
 */
function messageRecordsWithGlobalEnvelope(records: unknown[]): unknown[] {
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
  return raw;
}

export function transcriptRecordsToRawMessages(records: unknown[], limit: number): unknown[] {
  return transcriptRecordsToRawMessagePage(records, limit, 0).rawMessages;
}

/** One offset page over the filtered message records (same semantics as gateway `chat.history`). */
export type TranscriptMessagePage = {
  rawMessages: unknown[];
  /** Total filtered message records in the transcript (across all pages). */
  totalRecords: number;
};

/**
 * Slices one page of raw message records counting BACKWARDS from the newest
 * record: `offset` skips that many newest records first, then up to `limit`
 * older records are returned (still in storage order). `offset: 0` is the
 * newest tail page — identical to the legacy `limit`-only behavior.
 */
export function transcriptRecordsToRawMessagePage(
  records: unknown[],
  limit: number,
  offset: number,
): TranscriptMessagePage {
  const all = messageRecordsWithGlobalEnvelope(records);
  const totalRecords = all.length;
  const end = Math.max(0, totalRecords - Math.max(0, offset));
  const start = Math.max(0, end - Math.max(0, limit));
  if (end <= start) return { rawMessages: [], totalRecords };
  return { rawMessages: all.slice(start, end), totalRecords };
}

async function readTranscriptRecordsForSessionKey(sessionKey: string): Promise<TranscriptReadResult> {
  const row = findSessionStoreRow(sessionKey);
  const rt = getFridayAgentForwardRuntime();
  if (!row) return { records: [], authoritative: Boolean(rt?.readSessionTranscriptEvents) };
  let storePath: string | undefined;
  try {
    storePath = rt?.resolveStorePath(undefined, {
      agentId: agentIdFromSessionKey(row.sessionKey),
    });
  } catch {
    storePath = undefined;
  }
  return readTranscriptRecords({
    entry: row.entry,
    sessionKey: row.sessionKey,
    agentId: agentIdFromSessionKey(row.sessionKey),
    storePath,
  });
}

/**
 * Returns raw transcript message objects (newest tail up to `limit`), each with
 * an `__openclaw: { id, seq, recordTimestampMs }` envelope. Empty on any failure.
 */
export async function readSessionTranscriptRawMessages(
  sessionKey: string,
  limit: number,
): Promise<unknown[]> {
  return (await readSessionTranscriptRawMessagePage(sessionKey, limit, 0)).rawMessages;
}

/** Offset-paged variant of {@link readSessionTranscriptRawMessages}. */
export async function readSessionTranscriptRawMessagePage(
  sessionKey: string,
  limit: number,
  offset: number,
): Promise<TranscriptMessagePage & { authoritative: boolean }> {
  const result = await readTranscriptRecordsForSessionKey(sessionKey);
  return {
    ...transcriptRecordsToRawMessagePage(result.records, limit, offset),
    authoritative: result.authoritative,
  };
}

/** Finds one raw message by its stable transcript entry id (full detail). */
export async function readSessionTranscriptRawMessageById(
  sessionKey: string,
  messageId: string,
): Promise<Record<string, unknown> | undefined> {
  const { records } = await readTranscriptRecordsForSessionKey(sessionKey);
  const all = messageRecordsWithGlobalEnvelope(records);
  return all.find(
    (raw) => asRecord(asRecord(raw)?.__openclaw)?.id === messageId,
  ) as Record<string, unknown> | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Offset page served through the gateway's bounded read (null = unavailable). */
export type TranscriptGatewayPage = {
  rawMessages: unknown[];
  /** 近似计数：优先 stats.eventCount（含非 message 事件），否则下界。App 只用
   *  hasMore/nextOffset 驱动翻页，该值不参与逻辑。 */
  totalRecords: number;
  hasMore: boolean;
  nextOffset: number;
};

/**
 * Serves one offset page via the gateway `sessions.get` RPC instead of reading
 * the whole transcript locally: the gateway reads a bounded message window with
 * an index range query + byte budget (never materializing the full session),
 * and its messages carry the same `__openclaw` envelope our normalizer eats.
 *
 * Windowing: request the newest `offset + limit` records (tail pages add one
 * probe record to detect `hasMore`), then slice `[max(0, n-offset-limit),
 * max(0, n-offset))`. Returns null when the gateway surface is unavailable —
 * callers fall back to the local full read (identical wire output).
 */
export async function readSessionTranscriptPageViaGateway(
  sessionKey: string,
  limit: number,
  offset: number,
): Promise<TranscriptGatewayPage | null> {
  const rt = getFridayAgentForwardRuntime();
  if (!rt?.gatewayRequest) return null;
  const requestCount = offset === 0 ? limit + 1 : offset + limit;
  let payload: unknown;
  try {
    const available = rt.gatewayIsAvailable ? await rt.gatewayIsAvailable() : true;
    if (!available) return null;
    payload = await rt.gatewayRequest(
      "sessions.get",
      { key: toSessionStoreKey(sessionKey), limit: requestCount },
      { timeoutMs: 4_000, scopes: ["operator.read"] },
    );
  } catch {
    // COMPAT(older hosts): in-process gateway RPC surface missing/failing → local read.
    return null;
  }
  const messages = asRecord(payload)?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const n = messages.length;
  const end = Math.max(0, n - Math.max(0, offset));
  const start = Math.max(0, end - Math.max(0, limit));
  const rawMessages = end <= start ? [] : messages.slice(start, end);
  const hasMore = start > 0 || n >= requestCount;
  const nextOffset = Math.max(0, offset) + rawMessages.length;

  let totalRecords: number | undefined;
  const row = findSessionStoreRow(sessionKey);
  const sessionId = entryString(row?.entry, "sessionId");
  if (rt.readTranscriptStatsSync && sessionId) {
    try {
      const stats = rt.readTranscriptStatsSync({
        sessionId,
        sessionKey: row?.sessionKey ?? sessionKey,
        ...(agentIdFromSessionKey(row?.sessionKey ?? sessionKey)
          ? { agentId: agentIdFromSessionKey(row?.sessionKey ?? sessionKey) }
          : {}),
      });
      if (stats && Number.isFinite(stats.eventCount)) totalRecords = stats.eventCount;
    } catch {
      // 近似值拿不到就用下界。
    }
  }
  return {
    rawMessages,
    totalRecords: totalRecords ?? nextOffset + (hasMore ? 1 : 0),
    hasMore,
    nextOffset,
  };
}
