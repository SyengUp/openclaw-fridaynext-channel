/**
 * GET /friday-next/history/messages?sessionKey=&agentId=&limit=&offset=
 *
 * Returns a session's transcript history as a flat, normalized message stream.
 * The Friday app groups these into rounds itself (by role transitions) and uses
 * each message's stable `id` (the upstream transcript entry id) as its sync key.
 *
 * `offset` pages BACKWARDS over the raw transcript records (0 = newest tail,
 * same semantics as gateway `chat.history`); the response carries
 * `pagination: { offset, limit, totalRecords, hasMore, nextOffset? }` so the
 * app can load earlier history on demand. `seq` stays global across pages.
 *
 * Reads via the gateway `sessions.get` method (exposed to plugins as
 * `runtime.subagent.getSessionMessages`), which already resolves the active
 * branch and compaction, then normalizes each raw message into a stable DTO.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { getFridayNextRuntime } from "../../runtime.js";
import { extractBearerToken } from "../middleware/auth.js";
import { normalizeHistoryMessage, normalizeHistoryMessages } from "../../history/normalize-message.js";
import {
  readSessionTranscriptPageViaGateway,
  readSessionTranscriptRawMessageById,
  readSessionTranscriptRawMessagePage,
  resolveSessionId,
  resolveSessionTitle,
} from "../../history/read-transcript.js";
import { resolveMediaAttachment } from "./files.js";
import { readSessionUsageSnapshot } from "../../session-usage-store.js";
import type { FridayHistoryMessage } from "../../history/normalize-message.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/** Offset-page metadata over RAW transcript records (chat.history semantics). */
type HistoryPagination = {
  offset: number;
  limit: number;
  totalRecords: number;
  hasMore: boolean;
  nextOffset?: number;
};

type SubagentSessionApi = {
  getSessionMessages?: (params: {
    sessionKey: string;
    limit?: number;
  }) => Promise<{ messages?: unknown[] }>;
};

/**
 * For an `images[].url` produced from a `[media attached: …]` marker: returns the
 * server-local filesystem path to resolve (`file://…` or a bare absolute path), or
 * null to leave the image untouched. Already-served `/friday-next/files/…` URLs and
 * remote `http(s)://` / `data:` URLs are NOT local paths — never feed them to
 * `resolveMediaAttachment` (it would mis-treat them as paths and break valid URLs).
 */
/** Exported for unit tests (POSIX `/abs`, Windows `C:\abs`, `file://`). */
export function serverLocalPathForImageUrl(url: string): string | null {
  if (url.startsWith("file://")) {
    try {
      return fileURLToPath(url);
    } catch {
      // Malformed file URL — don't guess by slicing; a Windows `file:///C:/…`
      // that failed to parse would become `\Users\…` if we only strip `file://`.
      return null;
    }
  }
  if (url.startsWith("/friday-next/files/")) return null;
  // POSIX `/abs` and Windows `C:\abs` / `C:/abs` are local; http(s)/data are not.
  if (isAbsolute(url) || /^[A-Za-z]:[\\/]/.test(url)) return url;
  return null;
}

/** Resolve every transcript-local media reference into a stable plugin file URL. */
export function resolveHistoryMessageMedia(messages: FridayHistoryMessage[]): void {
  for (const message of messages) {
    if (message.mediaPaths?.length) {
      const resolved = message.mediaPaths
        .map((p) => resolveMediaAttachment(p))
        .filter((r): r is NonNullable<typeof r> => Boolean(r))
        .map((r) => ({ url: r.url, filename: r.fileName }));
      if (resolved.length) {
        message.images = [...(message.images ?? []), ...resolved];
      }
      delete message.mediaPaths;
    }

    if (message.images?.length) {
      message.images = message.images.map((img) => {
        if (!img.url || img.data) return img;
        const local = serverLocalPathForImageUrl(img.url);
        if (!local) return img;
        const resolved = resolveMediaAttachment(local);
        if (!resolved) return img;
        return { ...img, url: resolved.url, filename: img.filename ?? resolved.fileName };
      });
    }
  }
}

function resolveSubagentApi(): SubagentSessionApi | undefined {
  try {
    const runtime = getFridayNextRuntime();
    return (runtime as unknown as { subagent?: SubagentSessionApi }).subagent;
  } catch {
    return undefined;
  }
}

export async function handleHistoryMessages(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return true;
  }

  const token = extractBearerToken(req);
  if (!token) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Unauthorized: bearer token mismatch" }));
    return true;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const sessionKey = url.searchParams.get("sessionKey")?.trim();
  if (!sessionKey) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing required query param: sessionKey" }));
    return true;
  }
  const agentId = url.searchParams.get("agentId")?.trim() || undefined;
  const limitParam = Number(url.searchParams.get("limit"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(Math.floor(limitParam), MAX_LIMIT)
      : DEFAULT_LIMIT;
  // offset 从最新记录往回数（0 = 尾页），与 gateway `chat.history` 的分页语义一致。
  const offsetParam = Number(url.searchParams.get("offset"));
  if (
    url.searchParams.has("offset") &&
    (!Number.isFinite(offsetParam) || !Number.isSafeInteger(offsetParam) || offsetParam < 0)
  ) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ error: "offset must be a non-negative integer (records from newest)" }),
    );
    return true;
  }
  const offset = Number.isSafeInteger(offsetParam) && offsetParam > 0 ? offsetParam : 0;

  // Primary path: the gateway `sessions.get` bounded read (index window + byte
  // budget on the host — never materializes the whole transcript). Falls back to
  // reading the transcript file directly (older hosts / gateway RPC unavailable).
  const gatewayPage = await readSessionTranscriptPageViaGateway(sessionKey, limit, offset);
  let rawMessages: unknown[];
  let pagination: HistoryPagination | undefined;
  if (gatewayPage) {
    rawMessages = gatewayPage.rawMessages;
    pagination = {
      offset,
      limit,
      totalRecords: gatewayPage.totalRecords,
      hasMore: gatewayPage.hasMore,
      ...(gatewayPage.hasMore ? { nextOffset: gatewayPage.nextOffset } : {}),
    };
  } else {
    const page = readSessionTranscriptRawMessagePage(sessionKey, limit, offset);
    rawMessages = page.rawMessages;
    const hasMore = offset + page.rawMessages.length < page.totalRecords;
    pagination = {
      offset,
      limit,
      totalRecords: page.totalRecords,
      hasMore,
      ...(hasMore ? { nextOffset: offset + page.rawMessages.length } : {}),
    };
  }

  // Fallback: the request-scoped gateway method (only works in some contexts).
  // It returns the NEWEST TAIL only — never usable for an offset page.
  if (rawMessages.length === 0 && offset === 0 && gatewayPage === null) {
    const sessionApi = resolveSubagentApi();
    if (sessionApi?.getSessionMessages) {
      try {
        const response = await sessionApi.getSessionMessages({ sessionKey, limit });
        rawMessages = Array.isArray(response?.messages) ? response.messages : [];
        if (rawMessages.length > 0) {
          // 回退路径没有可靠的记录总数/nextOffset —— 省略分页元数据，客户端退回旧行为。
          pagination = undefined;
        }
      } catch {
        // Best-effort: an unreadable/unknown session yields an empty history
        // rather than an error, so the app degrades gracefully.
        rawMessages = [];
      }
    }
  }

  const messages = normalizeHistoryMessages(rawMessages);

  // Resolve `MEDIA:<server-path>` references into downloadable attachment URLs
  // (copies the file into the plugin's attachments/ dir — the same mechanism the
  // live deliver path uses), then drop the raw paths from the wire.
  resolveHistoryMessageMedia(messages);

  const sessionId = resolveSessionId(sessionKey);

  // The session's current displayName/label (AI title or user rename). The app
  // applies it to heal sessions still stuck in the pending-AI-title window — the
  // `session-title` push is a live nicety, this read is the deterministic catch-up.
  const sessionTitle = resolveSessionTitle(sessionKey);

  // Current prompt/context snapshot from the same projected `sessions.list` row
  // Control UI consumes. The transcript has no effective context-window figures.
  const sessionUsage = await readSessionUsageSnapshot(sessionKey);

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      ok: true,
      sessionKey,
      ...(agentId ? { agentId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(sessionTitle ? { title: sessionTitle } : {}),
      totalMessages: messages.length,
      messages,
      ...(pagination ? { pagination } : {}),
      ...(sessionUsage ? { sessionUsage } : {}),
    }),
  );
  return true;
}

/**
 * GET /friday-next/history/message-detail?sessionKey=&id=
 *
 * One transcript entry at FULL fidelity (no history-page truncation) — the
 * on-demand counterpart of `truncated: true` messages. 404 when the id is not
 * in the session.
 *
 * CLEANUP: currently scans the local full read for the id. Fine for an
 * explicit, low-frequency tap; swap to the host's single-message read
 * (`chat.message.get`-style RPC) when one is exposed to plugins.
 */
export async function handleHistoryMessageDetail(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return true;
  }

  const token = extractBearerToken(req);
  if (!token) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Unauthorized: bearer token mismatch" }));
    return true;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const sessionKey = url.searchParams.get("sessionKey")?.trim();
  const messageId = url.searchParams.get("id")?.trim();
  if (!sessionKey || !messageId) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing required query params: sessionKey, id" }));
    return true;
  }

  const raw = readSessionTranscriptRawMessageById(sessionKey, messageId);
  const message = raw ? normalizeHistoryMessage(raw, 0, { fullText: true }) : null;
  if (!message) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "message not found" }));
    return true;
  }
  resolveHistoryMessageMedia([message]);

  res.statusCode = 200;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: true, sessionKey, message }));
  return true;
}
