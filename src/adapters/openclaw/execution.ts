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
import { pathToFileURL } from "node:url";
import { runFridayDispatch } from "../../agent/dispatch-bridge.js";
import { saveInboundMediaBuffer } from "../../agent/media-bridge.js";
import { wasRecentlyUserAborted } from "../../agent/recent-aborts.js";
import { resolveFridayNextConfig } from "../../config.js";
import { touchFridayInbound } from "../../friday-inbound-stats.js";
import { forwardAgentEventRaw, isCodexRun } from "../../friday-session.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import {
  fridayAttachmentLookupKey,
  fridayFilesPublicUrl,
  readFile,
  rememberInboundMediaName,
  resolveMediaAttachment,
  resolveMediaUrl,
} from "../../http/handlers/files.js";
import { createFridayNextLogger, setFridayNextLogLevel } from "../../logging.js";
import {
  decodeRefURI,
  downloadInboundMedia,
  encodeRefURI,
  uploadOutboundMedia,
} from "../../public-access/oss-transfer.js";
import {
  deviceUsesPublicSurface,
  resolveOssOutboundConfig,
} from "../../public-access/outbound-media-oss.js";
import {
  noteFridayQuestionPrompt,
  readFridayAskUserBinding,
} from "../../question/friday-question.js";
import {
  getRunMetadata,
  getRunRoute,
  hasRunFinalDelivered,
  markRunFinalDelivered,
  setRunMetadata,
} from "../../run-metadata.js";
import { getFridayNextRuntime } from "../../runtime.js";
import { readSessionUsageSnapshot } from "../../session-usage-store.js";
import {
  isSessionPermissionMode,
  resolveAgentDefaults,
  setSessionSettings,
  splitModelRef,
  type FridaySessionSettingsUpdate,
} from "../../session/session-manager.js";
import { maybeGenerateSessionTitle } from "../../session/session-title-generator.js";
import { sseEmitter } from "../../sse/emitter.js";
import { clampThinkingLevelForRef } from "../../thinking-levels.js";

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
  if (Object.keys(nextFridayNext).length > 0) {
    raw.channelData = {
      ...baseChannelData,
      fridayNext: nextFridayNext,
    };
  }
  return raw;
}

export function scheduleLateFinalMetaPatch(runId: string, attempts = 6): void {
  const route = getRunRoute(runId);
  if (!route) return;
  const intervalMs = 300;
  const tryOnce = async (remaining: number) => {
    const meta = getRunMetadata(runId);
    const sessionUsage = await readSessionUsageSnapshot(route.sessionKey);
    if (
      meta?.modelName ||
      typeof meta?.totalTokens === "number" ||
      sessionUsage?.context?.used !== undefined ||
      sessionUsage?.context?.windowMax !== undefined
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
            modelName: meta?.modelName ?? null,
            totalTokens: typeof meta?.totalTokens === "number" ? meta.totalTokens : null,
            contextTokensUsed: sessionUsage?.context?.used ?? null,
            contextWindowMax: sessionUsage?.context?.windowMax ?? null,
            ts: Date.now(),
          },
        },
        true,
      );
      return;
    }
    if (remaining <= 0) return;
    setTimeout(() => void tryOnce(remaining - 1), intervalMs);
  };
  setTimeout(() => void tryOnce(attempts), intervalMs);
}

function pickMetadataFromMessageLike(message: unknown): {
  modelName?: string;
  totalTokens?: number;
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

  if (!modelName && !(totalTokens > 0)) return null;
  return {
    modelName,
    totalTokens: totalTokens > 0 ? totalTokens : undefined,
  };
}

async function resolveRunMetadataFromRuntimeSession(
  runtime: ReturnType<typeof getFridayNextRuntime>,
  sessionKey: string,
): Promise<{
  modelName?: string;
  totalTokens?: number;
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
  expectedServerInstanceId?: string;
  deviceId: string;
  text: string;
  sessionKey: string;
  agentId?: string;
  clientRequestId?: string;
  attachments?: string[];
  modelRef?: string;
  reasoningLevel?: string;
  thinkingLevel?: string;
  permissionMode?: string | null;
}

/**
 * Ordered inbound media fact for core's facts-first contract (`MsgContext.media`,
 * `InboundMediaFacts` in OpenClaw ≥ facts-first / 2026.8.x). Shape mirrors core's
 * `ChannelInboundMediaInput`. `path` MUST be a loadable local file — this is what
 * core hydrates prompt images (and audio/video understanding) from; `url` is the
 * stable channel URL kept for display/history.
 */
export interface FridayInboundMediaFact {
  path: string;
  url: string;
  contentType: string;
  fileName?: string;
  kind?: "image" | "audio" | "video" | "document";
}

/** Mirrors core's `mediaKindFromMime` for the four fact kinds; unknown → undefined. */
export function inboundMediaKindFromMime(
  mime: string,
): "image" | "audio" | "video" | "document" | undefined {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime) return "document";
  return undefined;
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

/** OSS transfer config from the resolved plugin config, or null when public access is off.
 * Shared with the message-tool outbound path (`outbound-media-oss.ts`) so both stay in lockstep. */
const ossTransferConfig = resolveOssOutboundConfig;

/** Rewrite outbound deliver-payload media (`/friday-next/files/<token>` URLs the translate step
 * produced) into `fnoss:v1:…` references: read the local bytes, encrypt + upload to OSS, swap the
 * URL. No-op when public access is off or the target device's SSE stream is LAN-direct (only
 * publicly-connected devices divert — OSS traffic costs money and LAN is faster); on upload
 * failure the tunnel URL is kept (graceful). */
async function ossRewriteOutboundMedia(
  raw: Record<string, unknown>,
  deviceId: string | undefined,
): Promise<void> {
  if (!deviceUsesPublicSurface(deviceId)) return;
  const cfg = ossTransferConfig();
  if (!cfg) return;
  const filesPrefix = "/friday-next/files/";
  const rewrite = async (u: unknown): Promise<unknown> => {
    if (typeof u !== "string" || !u.startsWith(filesPrefix)) return u;
    const token = u.slice(filesPrefix.length).split("?")[0];
    const { buffer, mimeType, filename } = readFile(fridayAttachmentLookupKey(token));
    if (!buffer) return u;
    const mime = mimeType || "application/octet-stream";
    const ref = await uploadOutboundMedia(cfg, buffer, {
      name: filename || "attachment",
      mime,
      isImage: mime.startsWith("image/"),
    });
    return ref ? encodeRefURI(ref) : u; // upload failed → keep the tunnel URL
  };
  if (typeof raw.mediaUrl === "string") raw.mediaUrl = await rewrite(raw.mediaUrl);
  if (Array.isArray(raw.mediaUrls)) {
    raw.mediaUrls = await Promise.all((raw.mediaUrls as unknown[]).map(rewrite));
  }
}

/** Attachments resolved for the agent turn: the marker-composed body plus ordered media facts. */
export interface AgentTurnAttachmentInput {
  body: string;
  mediaFacts: FridayInboundMediaFact[];
}

async function buildBodyForAgentWithAttachments(
  text: string,
  attachmentIds: string[],
): Promise<AgentTurnAttachmentInput> {
  if (attachmentIds.length === 0) return { body: text.trim(), mediaFacts: [] };

  const ossCfg = ossTransferConfig();
  const mediaRefs: string[] = [];
  const mediaFacts: FridayInboundMediaFact[] = [];
  for (const id of attachmentIds) {
    // LEGACY-COMPAT (see the `MediaUrls` note in handleMessages): the `[media attached: …]` body
    // marker is what pre-facts-first cores hydrate prompt images from. Facts-first cores dedupe it
    // against `mediaFacts` below, so it stays harmless there and load-bearing here.
    // Phase E: an OSS side-channel reference (`fnoss:v1:…`) instead of a local upload id — download
    // the ciphertext from OSS and decrypt it here (the app encrypted it with a key delivered in the
    // ref). On any failure we skip; the app only sends an OSS ref when the side-channel was usable.
    const ossRef = ossCfg ? decodeRefURI(id) : null;
    if (ossRef) {
      const plain = await downloadInboundMedia(ossCfg!, ossRef);
      if (plain) {
        const saved = await saveInboundMediaBuffer(plain, ossRef.mime, ossRef.name);
        if (saved.id && saved.path) {
          if (ossRef.name) rememberInboundMediaName(saved.path, ossRef.name, ossRef.mime);
          const channelUrl = fridayFilesPublicUrl(id);
          mediaRefs.push(`[media attached: ${pathToFileURL(saved.path).href}]`);
          mediaFacts.push(toInboundMediaFact(saved.path, channelUrl, ossRef.mime, ossRef.name));
        }
      }
      continue;
    }
    const lookupKey = fridayAttachmentLookupKey(id);
    const { buffer, mimeType, filename } = readFile(lookupKey);
    if (!buffer) continue;

    const saved = await saveInboundMediaBuffer(buffer, mimeType, filename);
    if (saved.id && saved.path) {
      // Core's media-store renames inbound files to a bare uuid (no name/extension) and
      // the transcript records that path — stash the original name now so history rebuild
      // can restore it instead of surfacing the uuid.
      if (filename) rememberInboundMediaName(saved.path, filename, mimeType);
      mediaRefs.push(`[media attached: ${pathToFileURL(saved.path).href}]`);
      mediaFacts.push(
        toInboundMediaFact(saved.path, fridayFilesPublicUrl(lookupKey), mimeType, filename),
      );
    }
  }

  return { body: composeBodyWithMediaRefs(text, mediaRefs), mediaFacts };
}

/** Builds one facts-first media fact from a saved inbound file; path is the hydratable local file. */
function toInboundMediaFact(
  localPath: string,
  channelUrl: string,
  mimeType: string,
  filename?: string,
): FridayInboundMediaFact {
  const fact: FridayInboundMediaFact = {
    path: localPath,
    url: channelUrl,
    contentType: mimeType || "application/octet-stream",
    kind: inboundMediaKindFromMime(mimeType) ?? "document",
  };
  const name = filename?.trim();
  if (name) fact.fileName = name;
  return fact;
}

// 宿主执行器只准备 OpenClaw 上下文并调用 SDK；排队、恢复与终态由 Kit 负责。
export async function executeOpenClawRun(
  run: import("@syengup/fridaynext-channel-kit").DurableRunRecord,
): Promise<void> {
  const {
    runId,
    deviceId: normalizedDeviceId,
    sessionKey: baseSessionKey,
    text: trimmedText,
    attachments,
    clientRequestId,
  } = run;
  const payload = (run.sessionOptions ?? {}) as Pick<
    FridayMessagePayload,
    "modelRef" | "reasoningLevel" | "thinkingLevel" | "permissionMode"
  >;
  const runtime = getFridayNextRuntime();
  const isSlashCommand = trimmedText.startsWith("/");
  touchFridayInbound();
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
  // The agent's configured `thinkingDefault` (or a session default) can be a level the effective
  // model does not support after a model switch (e.g. `high` on a binary off/on provider). Core
  // accepts an unsupported level silently for *defaults* — it clamps them — but hard-rejects an
  // unsupported explicit per-turn override, and `thinkingLevelOverride` below is explicit. Clamp
  // once here so the stored setting, the override and the level the composer shows agree.
  const thinkingLevel = clampThinkingLevelForRef(
    modelRef,
    payload.thinkingLevel ?? defaultThinking,
  );

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
  if (payload.permissionMode === null) {
    settings.permissionMode = null;
  } else if (isSessionPermissionMode(payload.permissionMode)) {
    settings.permissionMode = payload.permissionMode;
  }

  if (Object.keys(settings).length > 0) {
    await setSessionSettings(baseSessionKey, settings, cfg.historyDir);
  }

  log(
    "SESSION_SETTINGS",
    normalizedDeviceId,
    runId,
    `sessionKey=${baseSessionKey} modelRef=${modelRef ?? "(default)"} reasoning=${reasoningLevel ?? "(default)"} thinking=${thinkingLevel ?? "(default)"} permission=${payload.permissionMode === undefined ? "(unchanged)" : (payload.permissionMode ?? "(default)")}`,
  );

  const { body: bodyForAgent, mediaFacts: inboundMediaFacts } =
    await buildBodyForAgentWithAttachments(trimmedText, attachments);

  const msgContext = {
    Body: trimmedText,
    BodyForAgent: bodyForAgent,
    RawBody: trimmedText,
    CommandBody: trimmedText,
    BodyForCommands: trimmedText,
    SenderId: normalizedDeviceId,
    OwnerAllowFrom: [normalizedDeviceId],
    From: normalizedDeviceId,
    // Match the bundled-provider inbound routing contract used by Telegram. Core persists these
    // fields as deliveryContext / lastChannel / lastTo; notification-channel binding and future
    // proactive delivery require both the channel and target to be present.
    To: normalizedDeviceId,
    OriginatingChannel: "friday-next" as const,
    OriginatingTo: normalizedDeviceId,
    AccountId: "default",
    Surface: "friday-next" as const,
    SessionKey: baseSessionKey,
    // Facts-first media contract (OpenClaw ≥ 2026-07-24 facts-first; required for 2026.8.x where
    // core hydrates prompt images from these ordered facts — `path` is the loadable local inbound
    // file saved above). Older cores ignore this unknown field and fall through to the legacy
    // projection + body markers below, so both generations stay on one code path.
    media: inboundMediaFacts,
    // LEGACY-COMPAT(media-legacy-projection): deprecated upstream 2026-07-24 (compat record
    // `media-legacy-projection`, upstream removal gated ≥ 2026-10-01). Kept ONLY so cores predating
    // facts-first still see MediaUrl(s); on facts-first cores canonical `media` above wins and this
    // is merged in as display `url` only. CLEANUP: once the minimum supported OpenClaw is
    // facts-first, delete this line (and the `fridayFilesPublicUrl` import if unused elsewhere).
    MediaUrls: attachments.map(fridayFilesPublicUrl),
    channel: "friday-next" as const,
    Provider: "friday-next" as const,
    ChatType: "direct" as const,
    CommandAuthorized: true,
    // 宿主通过标准消息身份持久化 transport.messageId；任意 idempotencyKey 上下文字段不会落盘。
    MessageSid: clientRequestId || undefined,
    // `"text"`, NOT `"native"`. This channel is a TEXT command surface — it never registers
    // provider-native commands (no `capabilities.nativeCommands`), so a slash command arrives as
    // ordinary body text.
    //
    // Marking it `"native"` (as this did until 2026-08-01) makes `isNativeCommandTurn()` true, which
    // sends the turn down core's NATIVE SLASH FAST PATH
    // (auto-reply/reply/get-reply-native-slash-fast-path.ts). That path is built for channels that
    // answer the invocation themselves (Discord/Telegram interaction replies): it RETURNS the reply
    // to its caller instead of pushing it through the dispatcher's `deliver` callback. We only
    // consume `deliver`, so every slash command silently produced nothing — POST 202, then total
    // silence, not even lifecycle events.
    //
    // `"text"` is also safe against the operator kill switch: `shouldHandleTextCommands` short-
    // circuits true unless `commands.text === false`, and even then only for surfaces that DO
    // register native commands — which this one doesn't.
    CommandSource: isSlashCommand ? ("text" as const) : undefined,
  };

  // Runs the dispatch. Returns true when it resolved cleanly; false when the
  // error path already handled the outcome.
  const runAgentAttempt = async (): Promise<boolean> => {
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
            // ask_user prompt: track the pending question (serial-queue answer bypass) and
            // bridge its terminal state back over SSE. The prompt payload itself still flows
            // to the app unchanged (presentation + channelData.askUser ride along).
            const askUser = readFridayAskUserBinding(payload);
            if (askUser) {
              await noteFridayQuestionPrompt({
                questionId: askUser.questionId,
                sessionKey: baseSessionKey,
                deviceId: normalizedDeviceId,
                runId,
              });
            }
            // Phase E: when public access is on AND this device is connected via the public relay,
            // move outbound media off the tunnel — read the just-resolved `/friday-next/files/…`
            // bytes, encrypt + upload to OSS, and rewrite the URL to a `fnoss:v1:…` reference the
            // app downloads + decrypts directly. LAN devices and upload failures keep the tunnel
            // URL (graceful fallback).
            await ossRewriteOutboundMedia(payload, normalizedDeviceId);
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
              // The context ring comes only from the projected sessions.list row.
              // Always emit a post-settle patch even when per-run model metadata
              // was already available in the final deliver payload.
              scheduleLateFinalMetaPatch(runId);
            }
          },
          onError: (err: unknown) => {
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

  void maybeGenerateSessionTitle({
    sessionKey: baseSessionKey,
    firstUserMessage: trimmedText,
    deviceId: normalizedDeviceId,
    runId,
  }).catch((err: unknown) => {
    log("TITLE_GENERATION_ERROR", normalizedDeviceId, runId, String(err), "warn");
  });
  if (!(await runAgentAttempt())) throw new Error("OpenClaw dispatch failed");
}
