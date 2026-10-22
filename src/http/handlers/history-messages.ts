import { ChannelError, type HistoryQuery } from "@syengup/fridaynext-channel-kit";
import { createSessionHandlers } from "@syengup/fridaynext-channel-kit/transport/sessions";
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

import { getRuntimeV3Store } from "../../runtime-v3/runtime-store.js";
import { toSessionStoreKey } from "../../session/session-manager.js";
import { canonicalHistory } from "../../adapters/openclaw/history-projection.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { getFridayNextRuntime } from "../../runtime.js";
import { extractBearerToken } from "../middleware/auth.js";
import {
  normalizeHistoryMessage,
  normalizeHistoryMessages,
} from "../../history/normalize-message.js";
import {
  readSessionTranscriptPageViaGateway,
  readSessionTranscriptRawMessageById,
  readSessionTranscriptRawMessages,
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
  identityAttempt = 0,
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

  try {
    const result = await readOpenClawHistory(
      { sessionKey, agentId, limit, offset },
      req.headers["x-fridaynext-event-format"] === "canonical-v1",
      identityAttempt,
    );
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  } catch (error) {
    if (!(error instanceof ChannelError)) throw error;
    res.statusCode = error.status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, code: error.code, error: error.message }));
  }
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
export async function handleHistoryMessageDetail(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const canonical = req.headers["x-fridaynext-event-format"] === "canonical-v1";
  return createSessionHandlers({
    authenticate: (request) => extractBearerToken(request) !== null,
    adapter: { historyMessage: async (key, id) => {
      const message = readOpenClawHistoryMessage(key, id, canonical);
      return message ? JSON.parse(JSON.stringify(message)) as import("@syengup/fridaynext-channel-kit").JSONObject : null;
    } },
  }).handleHistoryDetail(req, res);
}

export function ownedHistoryRequests(sessionKey: string): ReadonlySet<string> {
  return new Set(getRuntimeV3Store().runs()
    .filter((run) => toSessionStoreKey(run.sessionKey) === toSessionStoreKey(sessionKey) && run.origin !== "observed")
    .map((run) => run.clientRequestId));
}

export function historyRunRequests(sessionKey: string): ReadonlyMap<string, string> {
  return new Map(getRuntimeV3Store().runs()
    .filter((run) => toSessionStoreKey(run.sessionKey) === toSessionStoreKey(sessionKey))
    .map((run) => [run.runId, run.clientRequestId]));
}

// 精确会话及请求归属下，频道准入文本比模型输入中的宿主追加内容更权威。
export function historyUserTexts(sessionKey: string): ReadonlyMap<string, string> {
  const runs = getRuntimeV3Store().runs().filter((run) =>
    toSessionStoreKey(run.sessionKey) === toSessionStoreKey(sessionKey) && run.origin !== "observed");
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.clientRequestId, (counts.get(run.clientRequestId) ?? 0) + 1);
  return new Map(runs
    .filter((run) => counts.get(run.clientRequestId) === 1 && Array.isArray(run.attachments)
      && run.attachments.length > 0 && typeof run.text === "string")
    .map((run) => [run.clientRequestId, run.text]));
}

// 单条全文仍使用整段历史的归一化上下文，保持控制文本和请求身份与列表一致。
export function readOpenClawHistoryMessage(sessionKey: string, id: string, canonical = true): FridayHistoryMessage | null {
  const key = toSessionStoreKey(sessionKey);
  for (let attempt = 0; attempt < 3; attempt++) {
    const identity = resolveSessionId(key);
    const raw = readSessionTranscriptRawMessageById(key, id);
    const full = raw ? normalizeHistoryMessage(raw, 0, { fullText: true }) : null;
    if (!full) return null;
    let message = full;
    if (canonical) {
      const context = normalizeHistoryMessages(readSessionTranscriptRawMessages(key, Number.MAX_SAFE_INTEGER));
      const index = context.findIndex((row) => row.id === full.id);
      if (index < 0) { if (identity !== resolveSessionId(key)) continue; return null; }
      context[index] = full;
      message = canonicalHistory(context, ownedHistoryRequests(key), historyRunRequests(key),
        { userTextByRequest: historyUserTexts(key), fullText: true })[index];
    }
    if (identity !== resolveSessionId(key)) continue;
    resolveHistoryMessageMedia([message]);
    return message;
  }
  throw new ChannelError(503, "UNAVAILABLE", "会话身份持续变化");
}

export async function readOpenClawHistory(
  query: HistoryQuery,
  canonical = true,
  identityAttempt = 0,
) {
  const { sessionKey, agentId, limit, offset } = query;
  const sessionId = resolveSessionId(sessionKey);
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

  const normalized = normalizeHistoryMessages(rawMessages);
  const messages = canonical
    ? canonicalHistory(
        normalized,
        ownedHistoryRequests(sessionKey),
        historyRunRequests(sessionKey),
        { userTextByRequest: historyUserTexts(sessionKey) },
      )
    : normalized;

  // Resolve `MEDIA:<server-path>` references into downloadable attachment URLs
  // (copies the file into the plugin's attachments/ dir — the same mechanism the
  // live deliver path uses), then drop the raw paths from the wire.
  resolveHistoryMessageMedia(messages);

  // The session's current displayName/label (AI title or user rename). The app
  // applies it to heal sessions still stuck in the pending-AI-title window — the
  // `session-title` push is a live nicety, this read is the deterministic catch-up.
  const sessionTitle = resolveSessionTitle(sessionKey);

  // Current prompt/context snapshot from the same projected `sessions.list` row
  // Control UI consumes. The transcript has no effective context-window figures.
  const sessionUsage = await readSessionUsageSnapshot(sessionKey);

  if (sessionId !== resolveSessionId(sessionKey)) {
    if (identityAttempt === 0) return readOpenClawHistory(query, canonical, 1);
    throw new ChannelError(503, "UNAVAILABLE", "Session changed while reading history");
  }
  return {
    ok: true,
    sessionKey,
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionTitle ? { title: sessionTitle } : {}),
    totalMessages: messages.length,
    messages,
    ...(pagination ? { pagination } : {}),
    ...(sessionUsage ? { sessionUsage } : {}),
  };
}
