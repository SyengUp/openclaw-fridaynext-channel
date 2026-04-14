/**
 * Message handler for POST /friday/messages
 *
 * Receives a message from the iOS app, dispatches it to the agent,
 * and streams events back via SSE.
 *
 * Uses dispatchReplyWithDispatcher from the plugin SDK (module-level export).
 * The deliver callback catches all tool and final replies for SSE broadcast.
 * Note: OriginatingChannel/OriginatingTo intentionally NOT set so that routing
 * falls through to the local dispatcher (friday is not a CHAT_CHANNEL_ORDER channel).
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchReplyWithDispatcher } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/browser-support";
import { getFridayRuntime } from "../../runtime.js";
import { ensureSessionLevels } from "../../session/session-manager.js";
import { sseEmitter } from "../../sse/emitter.js";
import { extractBearerToken } from "../middleware/auth.js";
import { notifyRunComplete, notifyRunError } from "../../agent/runner.js";
import { createFridayReplyCallbacks } from "../../agent/runner.js";
import { registerFridaySessionDeviceMapping } from "../../friday-session.js";
import {
  fridayAttachmentLookupKey,
  fridayFilesPublicUrl,
  guessMimeType,
  readFile,
  resolveMediaAttachment,
  resolveMediaUrl,
} from "./files.js";
import { createRound, createAssistantOnlyRound, appendAssistantBlock, clearHistory } from "../../conversation-history.js";
import {
  clearOutboundMediaSourceDedupe,
  hasOutboundMediaSource,
} from "../../outbound-media-source-dedupe.js";

const log = (action: string, deviceId: string, runId?: string, detail?: string) => {
  const ts = new Date().toISOString();
  const runPart = runId ? ` runId=${runId}` : "";
  const detailPart = detail ? ` detail=${detail}` : "";
  console.error(`[Friday-MSG] [${ts}] [${action}] deviceId=${deviceId}${runPart}${detailPart}`);
};

/** OpenClaw TTS sets `mediaUrl`; other paths use `mediaUrls`. Merge without duplicates. */
function collectReplyPayloadMediaUrls(pl: {
  mediaUrls?: string[];
  mediaUrl?: string | null;
}): string[] {
  const fromArr = Array.isArray(pl.mediaUrls)
    ? pl.mediaUrls.filter((u): u is string => typeof u === "string" && u.trim().length > 0)
    : [];
  const single = typeof pl.mediaUrl === "string" && pl.mediaUrl.trim() ? pl.mediaUrl.trim() : "";
  if (!single) return fromArr;
  if (fromArr.includes(single)) return fromArr;
  return [...fromArr, single];
}

/** Use dedicated SSE `tts` for voice / audio-only assistant media (incl. OpenClaw pipeline TTS). */
function sseMediaEventTypeForOutbound(
  audioAsVoice: boolean,
  resolved: Array<{ fileName: string; url: string }>,
): "tts" | "attachment" {
  if (audioAsVoice) return "tts";
  if (
    resolved.length > 0 &&
    resolved.every((a) => guessMimeType(a.fileName).toLowerCase().startsWith("audio/"))
  ) {
    return "tts";
  }
  return "attachment";
}

export interface FridayMessagePayload {
  deviceId: string;
  text: string;
  /** Set entirely by the app; passed through verbatim to OpenClaw (SessionKey) and history. */
  sessionKey: string;
  attachments?: string[];
}

async function parseBody<T>(req: IncomingMessage): Promise<T | null> {
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(JSON.parse(body) as T);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

/**
 * Build BodyForAgent with image attachments using OpenClaw's media://inbound/ URI scheme.
 *
 * The embedded agent detects [media attached: media://inbound/<id>] patterns in the prompt
 * and loads them via resolveMediaBufferPath -> loadWebMedia, making them available
 * as ImageContent to vision-capable models.
 */
async function buildBodyForAgentWithAttachments(
  text: string,
  attachmentIds: string[],
): Promise<string> {
  if (attachmentIds.length === 0) return text.trim();

  const mediaRefs: string[] = [];
  for (const id of attachmentIds) {
    const { buffer, mimeType } = readFile(fridayAttachmentLookupKey(id));
    if (!buffer) continue;

    // Store in OpenClaw's media buffer so the agent can resolve it.
    // Use file:// URL instead of media:// so the image tool can also access it directly.
    const saved = await saveMediaBuffer(buffer, mimeType, "inbound");
    if (saved.id && saved.path) {
      mediaRefs.push(`[media attached: file://${saved.path}]`);
    }
  }

  if (mediaRefs.length === 0) return text.trim();
  return `${text.trim()}\n\n${mediaRefs.join("\n")}`;
}

export async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return true;
  }

  const token = extractBearerToken(req);
  if (!token) {
    log("AUTH_FAILED", "(unknown)", undefined, "missing or invalid token");
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Unauthorized: missing bearer token" }));
    return true;
  }

  const payload = await parseBody<FridayMessagePayload>(req);
  if (!payload) {
    log("BAD_REQUEST", "(unknown)", undefined, "invalid JSON body");
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return true;
  }

  const { deviceId, text, attachments = [], sessionKey: rawSessionKey } = payload;

  if (typeof rawSessionKey !== "string" || !rawSessionKey.length) {
    log("BAD_REQUEST", "(unknown)", undefined, "missing sessionKey");
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing required field: sessionKey" }));
    return true;
  }

  const baseSessionKey = rawSessionKey;

  if (!deviceId || !deviceId.trim()) {
    log("BAD_REQUEST", "(unknown)", undefined, "missing deviceId");
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing required field: deviceId" }));
    return true;
  }

  if (!text || !text.trim()) {
    log("BAD_REQUEST", deviceId, undefined, "missing text");
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing required field: text" }));
    return true;
  }

  const trimmedText = text.trim();

  // Slash commands: CommandSource "native" + CommandAuthorized true (see below) so OpenClaw
  // does not silently drop whole-message /new, /reset, /help, etc. (reply pipeline requires
  // commandAuthorized || isAuthorizedSender for control/reset commands).
  const isSlashCommand = trimmedText.startsWith("/");

  // /new and /reset also clear the friday channel's local history file (plugin-side rounds).
  const isResetCommand = /^\/(?:new|reset)\b/i.test(trimmedText);

  if (isSlashCommand) {
    log("SLASH_COMMAND", deviceId, undefined, `text=${trimmedText}`);
    if (isResetCommand) {
      clearHistory(baseSessionKey);
    }
  }

  // Normal message: acknowledge and process via agent
  res.statusCode = 202;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ accepted: true, deviceId }));

  const runId = crypto.randomUUID();
  const runtime = getFridayRuntime();

  log("MESSAGE_RECEIVED", deviceId, runId,
    `textLen=${trimmedText.length} attachments=${attachments.length} sessionKey=${baseSessionKey}`);

  // Ensure session exists in sessions.json with reasoningLevel="stream" BEFORE the
  // dispatch call so that initSessionState inside the dispatcher finds it and
  // sets resolvedReasoningLevel="stream", which enables onReasoningStream in the
  // embedded agent runner (streamReasoning = reasoningMode === "stream").
  ensureSessionLevels(baseSessionKey, "stream", "medium");

  registerFridaySessionDeviceMapping(baseSessionKey, deviceId);
  sseEmitter.trackDeviceForRun(deviceId, runId);
  // Tell the client this run has started immediately (before attachment I/O and dispatch).
  sseEmitter.broadcastToRun(
    runId,
    { type: "agent", data: { event: "run-start", runId, deviceId } },
    true,
  );
  log("RUN_START", deviceId, runId, "immediate");

  // Build BodyForAgent with media://inbound/<id> refs so the embedded agent
  // can detect and load them as ImageContent.
  const bodyForAgent = await buildBodyForAgentWithAttachments(text, attachments);

  // OriginatingChannel stays unset so shouldRouteToOriginating stays false (no cross-channel routeReply).
  // OriginatingTo MUST be the deviceId: embedded tools (sessions_spawn) pass agentTo = resolveOriginMessageTo(
  //   { originatingTo, to }) — without this, sub-agent announce delivery uses To:"friday" and
  // getConnection("friday") misses the SSE keyed by deviceId (same pattern as Telegram/Feishu using real peer id).
  const msgContext = {
    Body: trimmedText,
    BodyForAgent: bodyForAgent,
    RawBody: trimmedText,
    CommandBody: trimmedText,
    BodyForCommands: trimmedText,
    From: deviceId,
    To: "friday",
    OriginatingTo: deviceId.trim(),
    SessionKey: baseSessionKey,
    MediaUrls: attachments.map(fridayFilesPublicUrl),
    channel: "friday" as const,
    /** Resolves friday in command-auth (allowFrom / owner), same as other channel inbound. */
    Provider: "friday" as const,
    ChatType: "direct" as const,
    /**
     * Bearer token already validated — treat sender as authorized for text commands so
     * /new, /reset, and other control commands are not dropped (see OpenClaw reply pipeline).
     */
    CommandAuthorized: true,
    CommandSource: isSlashCommand ? ("native" as const) : undefined,
  };

  const broadcast = (type: string, data: Record<string, unknown>, flushNow?: boolean) =>
    sseEmitter.broadcastToRun(runId, { type, data }, flushNow);

  const replyCallbacks = createFridayReplyCallbacks(baseSessionKey, runId);

  const runAgent = async () => {
    try {
      const userAttachmentUrls = attachments.map(fridayFilesPublicUrl);
      const userAttachmentItems = userAttachmentUrls
        .map((url) => resolveMediaAttachment(url))
        .filter((x): x is { fileName: string; url: string } => x !== null);

      // Create history round (newest first, max 20 rounds).
      // /new and /reset: clearHistory already ran; use assistant-only round so /new|/reset text is not stored.
      if (!isResetCommand) {
        createRound({
          sessionKey: baseSessionKey,
          runId,
          userText: text.trim(),
          attachments: userAttachmentUrls,
          attachmentItems: userAttachmentItems,
        });
      } else {
        createAssistantOnlyRound({ sessionKey: baseSessionKey, runId });
      }

      const attachmentSourceUrlsSent = new Set<string>();
      const resolveAttachmentsFromMediaUrls = (
        mediaUrls: string[],
      ): Array<{ fileName: string; url: string }> =>
        mediaUrls
          .map((url) => resolveMediaAttachment(url))
          .filter((x): x is { fileName: string; url: string } => x !== null);

      /** Same source dedupe as SSE: block+final must not double-append identical `mediaUrls`. */
      const consumeNovelAssistantMediaSources = (urls: string[]): string[] => {
        const novel: string[] = [];
        for (const u of urls) {
          if (attachmentSourceUrlsSent.has(u)) continue;
          if (hasOutboundMediaSource(runId, u)) continue;
          attachmentSourceUrlsSent.add(u);
          novel.push(u);
        }
        return novel;
      };

      const emitNovelAssistantMediaSse = (
        novel: string[],
        resolvedAttachments: Array<{ fileName: string; url: string }>,
        logSource: string,
        audioAsVoice: boolean,
      ): void => {
        if (novel.length === 0 || resolvedAttachments.length === 0) return;
        const sseType = sseMediaEventTypeForOutbound(Boolean(audioAsVoice), resolvedAttachments);
        log(
          "EVENT_SENT",
          deviceId,
          runId,
          `${logSource} ${sseType} count=${resolvedAttachments.length} urls=${novel.join(",")}`,
        );
        sseEmitter.broadcast(
          {
            type: sseType,
            data: {
              attachments: resolvedAttachments,
              runId,
              deviceId,
              timestamp: Date.now(),
              ...(audioAsVoice ? { audioAsVoice: true } : {}),
            },
          },
          deviceId,
          true,
        );
      };

      await dispatchReplyWithDispatcher({
        ctx: msgContext,
        cfg: runtime.config.loadConfig(),
        dispatcherOptions: {
          deliver: async (pl, info) => {
            const text = pl.text ?? "";
            const mediaUrls = collectReplyPayloadMediaUrls(pl);
            const isError = pl.isError ?? false;
            const audioAsVoice = pl.audioAsVoice === true;

            if (info.kind === "tool") {
              log("EVENT_SENT", deviceId, runId, `tool textLen=${text.length} isError=${isError}`);
              broadcast("tool", { phase: "result", text, isError, runId, deviceId });
            } else if (info.kind === "block") {
              const novelSources = consumeNovelAssistantMediaSources(mediaUrls);
              const resolved = resolveAttachmentsFromMediaUrls(novelSources);
              const mappedMediaUrls = resolved.map((a) => a.url);
              log(
                "EVENT_SENT",
                deviceId,
                runId,
                `block->final textLen=${text.length} novelMedia=${novelSources.length} isError=${isError}`,
              );

              // Do not emit "block" to app anymore. Convert block text into final delta.
              if (text) {
                broadcast("final", { text, runId, deviceId }, true);
              }

              emitNovelAssistantMediaSse(novelSources, resolved, "block", audioAsVoice);
              const blockMediaMsgType = sseMediaEventTypeForOutbound(audioAsVoice, resolved);
              appendAssistantBlock({
                sessionKey: baseSessionKey,
                runId,
                text,
                mediaUrls: mappedMediaUrls,
                attachments: resolved,
                isError,
                mediaMessageType: blockMediaMsgType,
              });
            } else if (info.kind === "final") {
              // Model-native text_delta events are delivered via onPartialReply (already
              // streaming). deliver("final") fires at the end with complete text for history
              // persistence only — no need to re-broadcast here.
              const novelSources = consumeNovelAssistantMediaSources(mediaUrls);
              const resolved = resolveAttachmentsFromMediaUrls(novelSources);
              const mappedMediaUrls = resolved.map((a) => a.url);
              log(
                "EVENT_SENT",
                deviceId,
                runId,
                `final deliver textLen=${text.length} novelMedia=${novelSources.length} isError=${isError} (history only)`,
              );
              emitNovelAssistantMediaSse(novelSources, resolved, "final", audioAsVoice);
              const finalMediaMsgType = sseMediaEventTypeForOutbound(audioAsVoice, resolved);
              appendAssistantBlock({
                sessionKey: baseSessionKey,
                runId,
                text,
                mediaUrls: mappedMediaUrls,
                attachments: resolved,
                isError,
                mediaMessageType: finalMediaMsgType,
              });
            }
          },
          onError: (err: unknown) => {
            log("RUN_ERROR", deviceId, runId, String(err));
            broadcast("run-error", { runId, deviceId, error: String(err) });
            notifyRunError(baseSessionKey, runId, String(err));
          },
        },
        replyOptions: {
          runId,
          suppressTyping: true,
          disableBlockStreaming: true,
          ...replyCallbacks,
        },
      });
      notifyRunComplete(baseSessionKey, runId);
      log("RUN_COMPLETE", deviceId, runId);
    } catch (err) {
      log("RUN_ERROR", deviceId, runId, String(err));
      notifyRunError(baseSessionKey, runId, String(err));
    } finally {
      clearOutboundMediaSourceDedupe(runId);
    }
  };

  runAgent().catch((err) => {
    log("RUN_ERROR", deviceId, runId, String(err));
    notifyRunError(baseSessionKey, runId, String(err));
  });

  return true;
}
