/**
 * GET /friday-next/history/messages?sessionKey=&agentId=&limit=
 *
 * Returns a session's transcript history as a flat, normalized message stream.
 * The Friday app groups these into rounds itself (by role transitions) and uses
 * each message's stable `id` (the upstream transcript entry id) as its sync key.
 *
 * Reads via the gateway `sessions.get` method (exposed to plugins as
 * `runtime.subagent.getSessionMessages`), which already resolves the active
 * branch and compaction, then normalizes each raw message into a stable DTO.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getFridayNextRuntime } from "../../runtime.js";
import { extractBearerToken } from "../middleware/auth.js";
import { normalizeHistoryMessages } from "../../history/normalize-message.js";
import { readSessionTranscriptRawMessages, resolveSessionId } from "../../history/read-transcript.js";
import { resolveMediaAttachment } from "./files.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

type SubagentSessionApi = {
  getSessionMessages?: (params: {
    sessionKey: string;
    limit?: number;
  }) => Promise<{ messages?: unknown[] }>;
};

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

  // Primary path: read the transcript file directly (works from an HTTP route).
  let rawMessages: unknown[] = readSessionTranscriptRawMessages(sessionKey, limit);

  // Fallback: the request-scoped gateway method (only works in some contexts).
  if (rawMessages.length === 0) {
    const sessionApi = resolveSubagentApi();
    if (sessionApi?.getSessionMessages) {
      try {
        const response = await sessionApi.getSessionMessages({ sessionKey, limit });
        rawMessages = Array.isArray(response?.messages) ? response.messages : [];
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
  for (const message of messages) {
    if (!message.mediaPaths?.length) continue;
    const resolved = message.mediaPaths
      .map((p) => resolveMediaAttachment(p))
      .filter((r): r is NonNullable<typeof r> => Boolean(r))
      .map((r) => ({ url: r.url, filename: r.fileName }));
    if (resolved.length) {
      message.images = [...(message.images ?? []), ...resolved];
    }
    delete message.mediaPaths;
  }

  const sessionId = resolveSessionId(sessionKey);

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      ok: true,
      sessionKey,
      ...(agentId ? { agentId } : {}),
      ...(sessionId ? { sessionId } : {}),
      totalMessages: messages.length,
      messages,
    }),
  );
  return true;
}
