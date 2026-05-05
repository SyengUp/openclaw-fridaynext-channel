/**
 * Message handler for POST /friday-next/messages
 *
 * Dispatches to the OpenClaw agent and streams native events via SSE (transparent proxy).
 *
 * **Owner / `nodes` tool visibility (OpenClaw):** With `tools.profile: "coding"`, add
 * `tools.alsoAllow: ["nodes"]` so profile filtering does not hide `nodes`. Bearer-authenticated
 * requests set `SenderId` and `OwnerAllowFrom` on the dispatch context so
 * `resolveCommandAuthorization` treats this device as owner when channel `allowFrom` is open
 * (empty / wildcard) and `commands.ownerAllowFrom` is not already a non-matching explicit list.
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
/** Subset of OpenClaw reply payload used for deliver translation (avoids static SDK import in tests). */
export type FridayReplyPayload = {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string | null;
  isError?: boolean;
  audioAsVoice?: boolean;
  isReasoning?: boolean;
  isCompactionNotice?: boolean;
  interactive?: unknown;
  channelData?: unknown;
};
import { resolveFridayNextConfig } from "../../config.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { getFridayNextRuntime } from "../../runtime.js";
import { ensureSessionLevels, toSessionStoreKey } from "../../session/session-manager.js";
import { sseEmitter } from "../../sse/emitter.js";
import { extractBearerToken } from "../middleware/auth.js";
import { readJsonBody } from "../middleware/body.js";
import { registerFridaySessionDeviceMapping } from "../../friday-session.js";
import { touchFridayInbound } from "../../friday-inbound-stats.js";
import {
  fridayAttachmentLookupKey,
  fridayFilesPublicUrl,
  readFile,
  resolveMediaAttachment,
  resolveMediaUrl,
} from "./files.js";
import { runFridayDispatch } from "../../agent/dispatch-bridge.js";
import { saveInboundMediaBuffer } from "../../agent/media-bridge.js";
import {
  contextTokensFromUsageRecord,
  getRunMetadata,
  getRunRoute,
  hasRunFinalDelivered,
  markRunFinalDelivered,
  registerRunRoute,
  setRunMetadata,
} from "../../run-metadata.js";

const log = (action: string, deviceId: string, runId?: string, detail?: string) => {
  const ts = new Date().toISOString();
  const runPart = runId ? ` runId=${runId}` : "";
  const detailPart = detail ? ` detail=${detail}` : "";
  console.error(`[Friday-MSG] [${ts}] [${action}] deviceId=${deviceId}${runPart}${detailPart}`);
};

function collectReplyPayloadMediaUrls(pl: { mediaUrls?: string[]; mediaUrl?: string | null }): string[] {
  const fromArr = Array.isArray(pl.mediaUrls)
    ? pl.mediaUrls.filter((u): u is string => typeof u === "string" && u.trim().length > 0)
    : [];
  const single = typeof pl.mediaUrl === "string" && pl.mediaUrl.trim() ? pl.mediaUrl.trim() : "";
  if (!single) return fromArr;
  if (fromArr.includes(single)) return fromArr;
  return [...fromArr, single];
}

function isAudioLikeUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.endsWith(".mp3") ||
    lower.endsWith(".wav") ||
    lower.endsWith(".ogg") ||
    lower.endsWith(".opus") ||
    lower.endsWith(".m4a") ||
    lower.endsWith(".aac") ||
    lower.endsWith(".flac") ||
    lower.includes("audio/")
  );
}

function inferFridayNextMediaKind(params: {
  originalUrls: string[];
  translatedUrls: string[];
  audioAsVoice?: boolean;
  kind: string;
}): "tts" | "tts_likely" | "audio" | "file" | "image" {
  const urls = params.translatedUrls.length > 0 ? params.translatedUrls : params.originalUrls;
  const hasAudio = urls.some(isAudioLikeUrl);
  const hasImage = urls.some((u) => {
    const lower = u.toLowerCase();
    return (
      lower.endsWith(".jpg") ||
      lower.endsWith(".jpeg") ||
      lower.endsWith(".png") ||
      lower.endsWith(".webp") ||
      lower.endsWith(".gif") ||
      lower.includes("image/")
    );
  });
  if (params.audioAsVoice === true && hasAudio) {
    return "tts";
  }
  if (hasAudio) {
    const sourceHints = params.originalUrls.join("\n").toLowerCase();
    const looksLikeGeneratedTts =
      sourceHints.includes("/tts-") ||
      sourceHints.includes("\\tts-") ||
      sourceHints.includes("/voice-") ||
      sourceHints.includes("\\voice-");
    if (looksLikeGeneratedTts || params.kind.toLowerCase() === "final") {
      return "tts_likely";
    }
    return "audio";
  }
  if (hasImage) {
    return "image";
  }
  return "file";
}

/** Map local / gateway paths to public `/friday-next/files/...` URLs where possible. */
function translateDeliverPayload(
  pl: FridayReplyPayload,
  kind: string,
  meta?: { modelName?: string; totalTokens?: number; contextTokensUsed?: number; contextWindowMax?: number },
): Record<string, unknown> {
  const raw = { ...pl } as Record<string, unknown>;
  const originalUrls = collectReplyPayloadMediaUrls(pl);
  if (typeof pl.mediaUrl === "string" && pl.mediaUrl.trim()) {
    const r = resolveMediaAttachment(pl.mediaUrl.trim());
    if (r) raw.mediaUrl = r.url;
  }
  if (Array.isArray(pl.mediaUrls)) {
    raw.mediaUrls = pl.mediaUrls.map((u) => {
      if (typeof u !== "string") return u;
      const r = resolveMediaAttachment(u);
      return r ? r.url : resolveMediaUrl(u);
    });
  }
  const translatedUrls = collectReplyPayloadMediaUrls({
    mediaUrl: typeof raw.mediaUrl === "string" ? raw.mediaUrl : null,
    mediaUrls: Array.isArray(raw.mediaUrls) ? (raw.mediaUrls as string[]) : undefined,
  });
  const baseChannelData =
    pl.channelData && typeof pl.channelData === "object" && !Array.isArray(pl.channelData)
      ? (pl.channelData as Record<string, unknown>)
      : {};
  const baseFridayNext =
    baseChannelData.fridayNext &&
    typeof baseChannelData.fridayNext === "object" &&
    !Array.isArray(baseChannelData.fridayNext)
      ? (baseChannelData.fridayNext as Record<string, unknown>)
      : {};

  const nextFridayNext: Record<string, unknown> = { ...baseFridayNext };
  if (translatedUrls.length > 0) {
    nextFridayNext.mediaKind = inferFridayNextMediaKind({
      originalUrls,
      translatedUrls,
      audioAsVoice: pl.audioAsVoice,
      kind,
    });
  }
  if (typeof meta?.modelName === "string" && meta.modelName.trim()) {
    nextFridayNext.modelName = meta.modelName.trim();
  }
  if (typeof meta?.totalTokens === "number" && Number.isFinite(meta.totalTokens) && meta.totalTokens > 0) {
    nextFridayNext.totalTokens = Math.floor(meta.totalTokens);
  }
  if (
    typeof meta?.contextTokensUsed === "number" &&
    Number.isFinite(meta.contextTokensUsed) &&
    meta.contextTokensUsed > 0
  ) {
    nextFridayNext.contextTokensUsed = Math.floor(meta.contextTokensUsed);
  }
  if (
    typeof meta?.contextWindowMax === "number" &&
    Number.isFinite(meta.contextWindowMax) &&
    meta.contextWindowMax > 0
  ) {
    nextFridayNext.contextWindowMax = Math.floor(meta.contextWindowMax);
  }
  if (Object.keys(nextFridayNext).length > 0) {
    raw.channelData = {
      ...baseChannelData,
      fridayNext: nextFridayNext,
    };
  }
  return raw;
}

function scheduleLateFinalMetaPatch(runId: string, attempts = 6): void {
  const route = getRunRoute(runId);
  if (!route) return;
  const intervalMs = 300;
  const tryOnce = (remaining: number) => {
    const meta = getRunMetadata(runId);
    if (
      meta?.modelName ||
      typeof meta?.totalTokens === "number" ||
      typeof meta?.contextTokensUsed === "number" ||
      typeof meta?.contextWindowMax === "number"
    ) {
      if (!hasRunFinalDelivered(runId)) return;
      sseEmitter.broadcastToRun(
        runId,
        {
          type: "outbound",
          data: {
            op: "final_meta",
            runId,
            deviceId: route.deviceId,
            sessionKey: route.sessionKey,
            modelName: meta.modelName ?? null,
            totalTokens: typeof meta.totalTokens === "number" ? meta.totalTokens : null,
            contextTokensUsed: typeof meta.contextTokensUsed === "number" ? meta.contextTokensUsed : null,
            contextWindowMax: typeof meta.contextWindowMax === "number" ? meta.contextWindowMax : null,
            ts: Date.now(),
          },
        },
        true,
      );
      return;
    }
    if (remaining <= 0) return;
    setTimeout(() => tryOnce(remaining - 1), intervalMs);
  };
  setTimeout(() => tryOnce(attempts), intervalMs);
}

function pickMetadataFromMessageLike(message: unknown): {
  modelName?: string;
  totalTokens?: number;
  contextTokensUsed?: number;
  contextWindowMax?: number;
} | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
  if (role && role !== "assistant") return null;
  const modelName =
    (typeof m.model === "string" && m.model.trim()) ||
    (typeof m.modelName === "string" && m.modelName.trim()) ||
    undefined;
  const usage =
    m.usage && typeof m.usage === "object" && !Array.isArray(m.usage)
      ? (m.usage as Record<string, unknown>)
      : undefined;
  const totalFromUsage =
    (typeof usage?.totalTokens === "number" && Number.isFinite(usage.totalTokens)
      ? usage.totalTokens
      : undefined) ??
    (typeof usage?.total === "number" && Number.isFinite(usage.total) ? usage.total : undefined) ??
    (typeof usage?.total_tokens === "number" && Number.isFinite(usage.total_tokens) ? usage.total_tokens : undefined);
  const totalFromMessage =
    (typeof m.totalTokens === "number" && Number.isFinite(m.totalTokens) ? m.totalTokens : undefined) ??
    (typeof m.total_tokens === "number" && Number.isFinite(m.total_tokens) ? m.total_tokens : undefined);
  const totalTokens = Math.floor((totalFromUsage ?? totalFromMessage ?? 0));

  let contextTokensUsed: number | undefined;
  if (usage) {
    const ctx = contextTokensFromUsageRecord(usage);
    if (typeof ctx === "number" && ctx > 0) {
      contextTokensUsed = ctx;
    }
  }

  const ctxMaxRaw =
    (typeof m.contextWindow === "number" && Number.isFinite(m.contextWindow) ? m.contextWindow : undefined) ??
    (typeof m.maxContextTokens === "number" && Number.isFinite(m.maxContextTokens) ? m.maxContextTokens : undefined);
  const contextWindowMax =
    typeof ctxMaxRaw === "number" && ctxMaxRaw > 0 ? Math.floor(ctxMaxRaw) : undefined;

  if (!modelName && !(totalTokens > 0) && !contextTokensUsed && !contextWindowMax) return null;
  return {
    modelName,
    totalTokens: totalTokens > 0 ? totalTokens : undefined,
    contextTokensUsed,
    contextWindowMax,
  };
}

async function resolveRunMetadataFromRuntimeSession(
  runtime: ReturnType<typeof getFridayNextRuntime>,
  sessionKey: string,
): Promise<{
  modelName?: string;
  totalTokens?: number;
  contextTokensUsed?: number;
  contextWindowMax?: number;
} | null> {
  const sessionApi = (runtime as unknown as {
    subagent?: { getSessionMessages?: (params: { sessionKey: string; limit?: number }) => Promise<{ messages?: unknown[] }> };
  }).subagent;
  if (!sessionApi?.getSessionMessages) return null;
  try {
    const response = await sessionApi.getSessionMessages({ sessionKey, limit: 80 });
    const messages = Array.isArray(response?.messages) ? response.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const picked = pickMetadataFromMessageLike(messages[i]);
      if (picked) return picked;
    }
  } catch {
    // Best-effort fallback only.
  }
  return null;
}

export interface FridayMessagePayload {
  deviceId: string;
  text: string;
  sessionKey: string;
  attachments?: string[];
}

async function buildBodyForAgentWithAttachments(text: string, attachmentIds: string[]): Promise<string> {
  if (attachmentIds.length === 0) return text.trim();

  const mediaRefs: string[] = [];
  for (const id of attachmentIds) {
    const { buffer, mimeType } = readFile(fridayAttachmentLookupKey(id));
    if (!buffer) continue;

    const saved = await saveInboundMediaBuffer(buffer, mimeType);
    if (saved.id && saved.path) {
      mediaRefs.push(`[media attached: file://${saved.path}]`);
    }
  }

  if (mediaRefs.length === 0) return text.trim();
  return `${text.trim()}\n\n${mediaRefs.join("\n")}`;
}

export async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
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

  const payload = (await readJsonBody(req)) as FridayMessagePayload | null;
  if (!payload) {
    log("BAD_REQUEST", "(unknown)", undefined, "invalid JSON body");
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return true;
  }

  const { deviceId, text, attachments = [], sessionKey: rawSessionKey } = payload;
  const normalizedDeviceId = deviceId?.trim().toUpperCase();

  if (typeof rawSessionKey !== "string" || !rawSessionKey.length) {
    log("BAD_REQUEST", "(unknown)", undefined, "missing sessionKey");
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing required field: sessionKey" }));
    return true;
  }

  const appSessionKey = rawSessionKey.trim();
  const baseSessionKey = toSessionStoreKey(appSessionKey);

  if (!normalizedDeviceId) {
    log("BAD_REQUEST", "(unknown)", undefined, "missing deviceId");
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing required field: deviceId" }));
    return true;
  }

  if (!text || !text.trim()) {
    log("BAD_REQUEST", normalizedDeviceId, undefined, "missing text");
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing required field: text" }));
    return true;
  }

  const trimmedText = text.trim();
  touchFridayInbound();

  const isSlashCommand = trimmedText.startsWith("/");

  const runId = crypto.randomUUID();
  const runtime = getFridayNextRuntime();

  res.statusCode = 202;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ accepted: true, deviceId: normalizedDeviceId, runId }));

  log(
    "MESSAGE_RECEIVED",
    normalizedDeviceId,
    runId,
    `textLen=${trimmedText.length} attachments=${attachments.length} sessionKey=${baseSessionKey}`,
  );

  const cfg = resolveFridayNextConfig(getHostOpenClawConfigSnapshot(runtime.config));
  ensureSessionLevels(baseSessionKey, "stream", "medium", cfg.historyDir);

  registerFridaySessionDeviceMapping(appSessionKey, normalizedDeviceId);
  sseEmitter.trackDeviceForRun(normalizedDeviceId, runId);
  registerRunRoute({ runId, deviceId: normalizedDeviceId, sessionKey: baseSessionKey });

  const bodyForAgent = await buildBodyForAgentWithAttachments(text, attachments);

  const msgContext = {
    Body: trimmedText,
    BodyForAgent: bodyForAgent,
    RawBody: trimmedText,
    CommandBody: trimmedText,
    BodyForCommands: trimmedText,
    SenderId: normalizedDeviceId,
    OwnerAllowFrom: [normalizedDeviceId],
    From: normalizedDeviceId,
    To: "friday-next",
    OriginatingTo: normalizedDeviceId,
    SessionKey: baseSessionKey,
    MediaUrls: attachments.map(fridayFilesPublicUrl),
    channel: "friday-next" as const,
    Provider: "friday-next" as const,
    ChatType: "direct" as const,
    CommandAuthorized: true,
    CommandSource: isSlashCommand ? ("native" as const) : undefined,
  };

  const runAgent = async () => {
    try {
      await runFridayDispatch({
        ctx: msgContext,
        cfg: getHostOpenClawConfigSnapshot(runtime.config),
        dispatcherOptions: {
          deliver: async (pl: any, info: any) => {
            let meta = getRunMetadata(runId);
            if (info.kind.toLowerCase() === "final" && !(meta?.modelName || typeof meta?.totalTokens === "number")) {
              const resolved = await resolveRunMetadataFromRuntimeSession(runtime, baseSessionKey);
              if (resolved) {
                setRunMetadata(runId, resolved);
                meta = getRunMetadata(runId);
              }
            }
            const payload = translateDeliverPayload(pl, info.kind, meta);
            log("EVENT_SENT", normalizedDeviceId, runId, `deliver kind=${info.kind}`);
            sseEmitter.broadcastToRun(
              runId,
              {
                type: "deliver",
                data: {
                  kind: info.kind,
                  payload,
                  runId,
                  sessionKey: baseSessionKey,
                  deviceId: normalizedDeviceId,
                  ts: Date.now(),
                },
              },
              true,
            );
            if (info.kind.toLowerCase() === "final") {
              markRunFinalDelivered(runId);
              if (!(meta?.modelName || typeof meta?.totalTokens === "number")) {
                scheduleLateFinalMetaPatch(runId);
              }
            }
          },
          onError: (err: unknown) => {
            log("RUN_ERROR", normalizedDeviceId, runId, String(err));
            sseEmitter.broadcastToRun(
              runId,
              {
                type: "outbound",
                data: {
                  op: "dispatch_error",
                  error: String(err),
                  runId,
                  sessionKey: baseSessionKey,
                  deviceId: normalizedDeviceId,
                  ts: Date.now(),
                },
              },
              true,
            );
          },
        },
        replyOptions: {
          runId,
          suppressTyping: true,
          disableBlockStreaming: true,
          onModelSelected: (sel: any) => {
            const name = typeof sel.model === "string" ? sel.model.trim() : "";
            if (name) {
              setRunMetadata(runId, { modelName: name });
            }
          },
          // OpenClaw `pi-embedded-subscribe` gates `streamReasoning` on `typeof onReasoningStream === "function"`.
          // Without this, `emitReasoningStream` never runs and Friday SSE never sees `stream: "thinking"`.
          onReasoningStream: async (pl: unknown) => {
            const text =
              typeof pl === "object" && pl !== null && "text" in pl
                ? String((pl as { text?: unknown }).text ?? "")
                : "";
            log("REASONING_STREAM", normalizedDeviceId, runId, `textLen=${text.length}`);
          },
          onReasoningEnd: async () => {
            log("REASONING_STREAM_END", normalizedDeviceId, runId);
          },
        },
      });
      log("RUN_COMPLETE", normalizedDeviceId, runId);
    } catch (err) {
      log("RUN_ERROR", normalizedDeviceId, runId, String(err));
      sseEmitter.broadcastToRun(
        runId,
        {
          type: "outbound",
          data: {
            op: "dispatch_error",
            error: String(err),
            runId,
            sessionKey: baseSessionKey,
            deviceId: normalizedDeviceId,
            ts: Date.now(),
          },
        },
        true,
      );
    } finally {
      sseEmitter.untrackRun(runId);
    }
  };

  runAgent().catch((err) => {
    log("RUN_ERROR", normalizedDeviceId, runId, String(err));
    sseEmitter.untrackRun(runId);
  });

  return true;
}
