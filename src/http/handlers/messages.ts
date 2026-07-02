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
import { wasRecentlyUserAborted } from "../../agent/recent-aborts.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { getFridayNextRuntime } from "../../runtime.js";
import {
  bumpSessionStoreMtime,
  resolveAgentDefaults,
  setSessionSettings,
  splitModelRef,
  toSessionStoreKey,
  type FridaySessionSettingsUpdate,
} from "../../session/session-manager.js";
import { sseEmitter } from "../../sse/emitter.js";
import { extractBearerToken } from "../middleware/auth.js";
import { readJsonBody } from "../middleware/body.js";
import {
  forwardAgentEventRaw,
  isCodexRun,
  registerFridaySessionDeviceMapping,
} from "../../friday-session.js";
import { touchFridayInbound } from "../../friday-inbound-stats.js";
import {
  fridayAttachmentLookupKey,
  fridayFilesPublicUrl,
  readFile,
  rememberInboundMediaName,
  resolveMediaAttachment,
  resolveMediaUrl,
} from "./files.js";
import { runFridayDispatch } from "../../agent/dispatch-bridge.js";
import { ensureSubagentSpawnScope } from "../../agent/operator-scope.js";
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
import { createFridayNextLogger, setFridayNextLogLevel } from "../../logging.js";

const logger = createFridayNextLogger("messages");

// Routine per-message / per-stream lifecycle events log at "debug" so they stay out of
// the default ("info") OpenClaw log; only genuine problems (rejections, run errors) surface.
// Raise the friday-next channel logLevel to "debug" to see the full per-message trace.
const log = (
  action: string,
  deviceId: string,
  runId?: string,
  detail?: string,
  level: "debug" | "info" | "warn" | "error" = "debug",
) => {
  const runPart = runId ? ` runId=${runId}` : "";
  const detailPart = detail ? ` detail=${detail}` : "";
  logger[level](`[${action}] deviceId=${deviceId}${runPart}${detailPart}`);
};

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
/**
 * Canvas snapshots are captured so the *agent* can "see" the rendered canvas. OpenClaw core surfaces
 * any image tool result as deliverable media on the assistant reply block, which for Friday Next would
 * make the snapshot auto-appear as an attachment mid-stream — not what we want. Snapshot temp files are
 * named `openclaw-canvas-snapshot-<uuid>.<ext>`, so we detect them by basename and drop them from the
 * delivered payload (the assistant text is preserved). Agent-initiated media sends are unaffected —
 * those flow through the `outbound` channel action, not the deliver block path.
 */
export function isCanvasSnapshotMediaPath(url: unknown): boolean {
  if (typeof url !== "string") return false;
  const base = url.split(/[/\\]/).pop() ?? url;
  return /canvas-snapshot-/i.test(base);
}

export function translateDeliverPayload(
  pl: FridayReplyPayload,
  kind: string,
  meta?: {
    modelName?: string;
    totalTokens?: number;
    contextTokensUsed?: number;
    contextWindowMax?: number;
  },
): Record<string, unknown> {
  // Strip canvas-snapshot tool-result images before any media resolution (paths here are still the
  // original `/tmp/openclaw/openclaw-canvas-snapshot-*.jpg` temp paths, not yet copied to friday files).
  const filteredSingle =
    typeof pl.mediaUrl === "string" && !isCanvasSnapshotMediaPath(pl.mediaUrl) ? pl.mediaUrl : null;
  const filteredArr = Array.isArray(pl.mediaUrls)
    ? pl.mediaUrls.filter((u) => !isCanvasSnapshotMediaPath(u))
    : pl.mediaUrls;
  pl = { ...pl, mediaUrl: filteredSingle, mediaUrls: filteredArr };

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
  if (
    typeof meta?.totalTokens === "number" &&
    Number.isFinite(meta.totalTokens) &&
    meta.totalTokens > 0
  ) {
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
            contextTokensUsed:
              typeof meta.contextTokensUsed === "number" ? meta.contextTokensUsed : null,
            contextWindowMax:
              typeof meta.contextWindowMax === "number" ? meta.contextWindowMax : null,
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
    (typeof usage?.total_tokens === "number" && Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : undefined);
  const totalFromMessage =
    (typeof m.totalTokens === "number" && Number.isFinite(m.totalTokens)
      ? m.totalTokens
      : undefined) ??
    (typeof m.total_tokens === "number" && Number.isFinite(m.total_tokens)
      ? m.total_tokens
      : undefined);
  const totalTokens = Math.floor(totalFromUsage ?? totalFromMessage ?? 0);

  let contextTokensUsed: number | undefined;
  if (usage) {
    const ctx = contextTokensFromUsageRecord(usage);
    if (typeof ctx === "number" && ctx > 0) {
      contextTokensUsed = ctx;
    }
  }

  const ctxMaxRaw =
    (typeof m.contextWindow === "number" && Number.isFinite(m.contextWindow)
      ? m.contextWindow
      : undefined) ??
    (typeof m.maxContextTokens === "number" && Number.isFinite(m.maxContextTokens)
      ? m.maxContextTokens
      : undefined);
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
  const sessionApi = (
    runtime as unknown as {
      subagent?: {
        getSessionMessages?: (params: {
          sessionKey: string;
          limit?: number;
        }) => Promise<{ messages?: unknown[] }>;
      };
    }
  ).subagent;
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
  modelRef?: string;
  reasoningLevel?: string;
  thinkingLevel?: string;
}

/**
 * 把可选文本与媒体引用拼成给 agent 的最终 body。纯附件（文本为空）场景下
 * 不能带前导空行，否则 agent 收到的是 `\n\n[media…]`——故拆成可测纯函数。
 */
export function composeBodyWithMediaRefs(text: string, mediaRefs: string[]): string {
  const trimmed = text.trim();
  if (mediaRefs.length === 0) return trimmed;
  return trimmed ? `${trimmed}\n\n${mediaRefs.join("\n")}` : mediaRefs.join("\n");
}

async function buildBodyForAgentWithAttachments(
  text: string,
  attachmentIds: string[],
): Promise<string> {
  if (attachmentIds.length === 0) return text.trim();

  const mediaRefs: string[] = [];
  for (const id of attachmentIds) {
    const { buffer, mimeType, filename } = readFile(fridayAttachmentLookupKey(id));
    if (!buffer) continue;

    const saved = await saveInboundMediaBuffer(buffer, mimeType, filename);
    if (saved.id && saved.path) {
      // Core's media-store renames inbound files to a bare uuid (no name/extension) and
      // the transcript records that path — stash the original name now so history rebuild
      // can restore it instead of surfacing the uuid.
      if (filename) rememberInboundMediaName(saved.path, filename, mimeType);
      mediaRefs.push(`[media attached: file://${saved.path}]`);
    }
  }

  return composeBodyWithMediaRefs(text, mediaRefs);
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
    log("AUTH_FAILED", "(unknown)", undefined, "missing or invalid token", "warn");
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Unauthorized: bearer token mismatch" }));
    return true;
  }

  const payload = (await readJsonBody(req)) as FridayMessagePayload | null;
  if (!payload) {
    log("BAD_REQUEST", "(unknown)", undefined, "invalid JSON body", "warn");
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return true;
  }

  const { deviceId, text, attachments = [], sessionKey: rawSessionKey } = payload;
  const normalizedDeviceId = deviceId?.trim().toUpperCase();

  if (typeof rawSessionKey !== "string" || !rawSessionKey.length) {
    log("BAD_REQUEST", "(unknown)", undefined, "missing sessionKey", "warn");
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing required field: sessionKey" }));
    return true;
  }

  const appSessionKey = rawSessionKey.trim();
  const baseSessionKey = toSessionStoreKey(appSessionKey);

  if (!normalizedDeviceId) {
    log("BAD_REQUEST", "(unknown)", undefined, "missing deviceId", "warn");
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing required field: deviceId" }));
    return true;
  }

  // 允许"只发附件、不发文本"：text 与 attachments 不能同时为空，但任一非空即放行。
  const hasText = Boolean(text && text.trim());
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  if (!hasText && !hasAttachments) {
    log("BAD_REQUEST", normalizedDeviceId, undefined, "missing text and attachments", "warn");
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing required field: text or attachments" }));
    return true;
  }

  const trimmedText = (text ?? "").trim();
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
  setFridayNextLogLevel(cfg.logLevel);

  // Resolve defaults from the OpenClaw agent config so settings are never left empty. Prefers the
  // target agent's own model/thinking over the global defaults (see resolveAgentDefaults).
  const { model: defaultModel, thinking: defaultThinking } = resolveAgentDefaults(baseSessionKey);

  const modelRef = payload.modelRef ?? defaultModel;
  const reasoningLevel = payload.reasoningLevel ?? "stream";
  const thinkingLevel = payload.thinkingLevel ?? defaultThinking;

  const settings: FridaySessionSettingsUpdate = {};
  if (modelRef) {
    settings.modelRef = modelRef;
    const split = splitModelRef(modelRef);
    // `?? null` clears a stale provider when the resolved ref is bare (no `provider/` prefix).
    settings.providerOverride = split.provider ?? null;
    settings.modelOverride = split.modelId;
  }
  if (reasoningLevel) settings.reasoningLevel = reasoningLevel;
  if (thinkingLevel) settings.thinkingLevel = thinkingLevel;

  if (Object.keys(settings).length > 0) {
    setSessionSettings(baseSessionKey, settings, cfg.historyDir);
  }

  log(
    "SESSION_SETTINGS",
    normalizedDeviceId,
    runId,
    `sessionKey=${baseSessionKey} modelRef=${modelRef ?? "(default)"} reasoning=${reasoningLevel ?? "(default)"} thinking=${thinkingLevel ?? "(default)"}`,
  );

  registerFridaySessionDeviceMapping(appSessionKey, normalizedDeviceId);
  sseEmitter.trackDeviceForRun(normalizedDeviceId, runId);
  registerRunRoute({ runId, deviceId: normalizedDeviceId, sessionKey: baseSessionKey });

  const bodyForAgent = await buildBodyForAgentWithAttachments(trimmedText, attachments);

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

  // OpenClaw core bug workaround (see bumpSessionStoreMtime): a session's first run can leave
  // core's 45s session-store cache stringify-divergent from disk, making every dispatch fail
  // with this exact error until the cache expires. Detect it, invalidate the cache via an mtime
  // bump, and retry the dispatch once. Any other error keeps the original single-attempt flow.
  const isReplySessionInitConflict = (err: unknown): boolean =>
    String(err).includes("reply session initialization conflicted");

  const runAgent = async () => {
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let retriableConflict = false;
        const takeConflictForRetry = (err: unknown): boolean => {
          if (attempt > 0 || !isReplySessionInitConflict(err)) return false;
          retriableConflict = true;
          return true;
        };
        const completed = await runAgentAttempt(takeConflictForRetry);
        if (!retriableConflict) {
          if (completed) log("RUN_COMPLETE", normalizedDeviceId, runId);
          return;
        }
        const bumped = bumpSessionStoreMtime(baseSessionKey, cfg.historyDir);
        log(
          "INIT_CONFLICT_RETRY",
          normalizedDeviceId,
          runId,
          `sessionKey=${baseSessionKey} storeMtimeBumped=${bumped}`,
          "warn",
        );
      }
    } finally {
      sseEmitter.untrackRun(runId);
    }
  };

  // Runs one dispatch attempt. Returns true when the dispatch resolved without a
  // conflict taken for retry; false when the error path already handled the outcome.
  const runAgentAttempt = async (
    takeConflictForRetry: (err: unknown) => boolean,
  ): Promise<boolean> => {
    try {
      await runFridayDispatch({
        ctx: msgContext,
        cfg: getHostOpenClawConfigSnapshot(runtime.config),
        dispatcherOptions: {
          deliver: async (pl: any, info: any) => {
            let meta = getRunMetadata(runId);
            if (
              info.kind.toLowerCase() === "final" &&
              !(meta?.modelName || typeof meta?.totalTokens === "number")
            ) {
              const resolved = await resolveRunMetadataFromRuntimeSession(runtime, baseSessionKey);
              if (resolved) {
                setRunMetadata(runId, resolved);
                meta = getRunMetadata(runId);
              }
            }
            const payload = translateDeliverPayload(pl, info.kind, meta);
            const deliverIsError =
              (payload as { isError?: boolean })?.isError || (pl as { isError?: boolean })?.isError;
            // Drop error deliveries that are a direct consequence of a user stop (the aborted
            // run's own failover, e.g. "LLM request failed."). The user already chose to stop;
            // surfacing it as an error toast is abort-noise, not a real failure.
            if (deliverIsError && wasRecentlyUserAborted(baseSessionKey)) {
              return;
            }
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
            if (takeConflictForRetry(err)) {
              return;
            }
            if (wasRecentlyUserAborted(baseSessionKey)) {
              return;
            }
            log("RUN_ERROR", normalizedDeviceId, runId, String(err), "error");
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
          // friday-next is a direct device channel: the final assistant reply auto-delivers
          // to the app live over SSE (sendText), and the channel already declares ChatType
          // "direct" + outbound.deliveryMode "direct". But OpenClaw core's source-reply policy
          // (resolveSourceReplyDeliveryMode) can still resolve `message_tool_only` for this
          // channel from its own defaults — when it does, the agent prompt tells the model
          // "visible replies are NOT auto-delivered; use message(action=send) for everything",
          // which makes Codex route its whole answer through the `message` tool (and that tool
          // crashes on friday-next). Pin `automatic` so core honors the channel's own direct
          // delivery and never instructs the model to deliver via the message tool.
          sourceReplyDeliveryMode: "automatic",
          // A1: feed the chosen thinking level into the run as a one-shot override so the model
          // request asks for a reasoning summary. The session-stored `thinkingLevel` alone is NOT
          // honored by the reply dispatch; `thinkingLevelOverride` has top priority in OpenClaw's
          // resolution chain (get-reply-directives). Required for Codex (openai-chatgpt-responses)
          // to emit any reasoning at all.
          ...(thinkingLevel ? { thinkingLevelOverride: thinkingLevel } : {}),
          onModelSelected: (sel: any) => {
            const name = typeof sel.model === "string" ? sel.model.trim() : "";
            if (name) {
              setRunMetadata(runId, { modelName: name });
            }
          },
          // OpenClaw `pi-embedded-subscribe` gates `streamReasoning` on `typeof onReasoningStream === "function"`.
          // Without this, `emitReasoningStream` never runs and Friday SSE never sees `stream: "thinking"`.
          onReasoningStream: async (pl: unknown) => {
            const rawText =
              typeof pl === "object" && pl !== null && "text" in pl
                ? (pl as { text?: unknown }).text
                : undefined;
            const text = typeof rawText === "string" ? rawText : "";
            log("REASONING_STREAM", normalizedDeviceId, runId, `textLen=${text.length}`);
            // A2: the embedded runner already emits `stream: "thinking"` on the agent-event bus, so
            // forwarding here would double it. The Codex app-server backend does NOT — reasoning text
            // only arrives via this callback (cumulative snapshot). Forward it as a thinking event
            // (reusing forwardAgentEventRaw's cumulative→delta rewrite) ONLY for Codex runs.
            if (text && isCodexRun(runId)) {
              forwardAgentEventRaw({
                runId,
                stream: "thinking",
                data: { text },
                sessionKey: baseSessionKey,
              });
            }
          },
          onReasoningEnd: async () => {
            log("REASONING_STREAM_END", normalizedDeviceId, runId);
          },
        },
      });
      return true;
    } catch (err) {
      if (takeConflictForRetry(err)) {
        return false;
      }
      log("RUN_ERROR", normalizedDeviceId, runId, String(err), "error");
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
      return false;
    }
  };

  // Elevate the route's (empty) operator scope so the dispatched agent can spawn
  // subagents. Must run here, synchronously inside the route's AsyncLocalStorage
  // context, so the live scope object the subagent spawn later reads carries
  // operator.write. See agent/operator-scope.ts.
  const elevatedScopes = ensureSubagentSpawnScope();
  if (elevatedScopes.length > 0) {
    log("SCOPE_ELEVATED", normalizedDeviceId, runId, elevatedScopes.join(","));
  }

  runAgent().catch((err) => {
    log("RUN_ERROR", normalizedDeviceId, runId, String(err), "error");
    sseEmitter.untrackRun(runId);
  });

  return true;
}
