import { appendAssistantBlock, getHistory } from "../conversation-history.js";
import { sseEmitter } from "../sse/emitter.js";
import {
  latestHistorySessionKeyForDeviceId,
  resolveFridayHistorySessionKey,
} from "../friday-session.js";
import { resolveMediaAttachment } from "../http/handlers/files.js";
import {
  collectMediaPathsFromToolResult,
  extractLocalPathsFromToolTextBlob,
} from "../collect-message-media-paths.js";
import { tryClaimOutboundMediaGroup } from "../outbound-media-source-dedupe.js";

type LogFn = (detail: string) => void;

const sentTtsAudioUrlsByRun = new Map<string, Set<string>>();

function markNovelTtsUrls(runId: string, urls: string[]): string[] {
  const sent = sentTtsAudioUrlsByRun.get(runId) ?? new Set<string>();
  const novel: string[] = [];
  for (const u of urls) {
    if (sent.has(u)) continue;
    sent.add(u);
    novel.push(u);
  }
  sentTtsAudioUrlsByRun.set(runId, sent);
  if (sentTtsAudioUrlsByRun.size > 2000) sentTtsAudioUrlsByRun.clear();
  return novel;
}

function readAudioAsVoiceFromTtsResult(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const details = (result as Record<string, unknown>).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const media = (details as Record<string, unknown>).media;
  if (!media || typeof media !== "object" || Array.isArray(media)) return false;
  return (media as Record<string, unknown>).audioAsVoice === true;
}

/**
 * OpenClaw `tts` tool returns audio in `details.audioPath` / `details.media.mediaUrl` (not in deliver() mediaUrls).
 * Emit the same `attachment` SSE + history as POST /friday/messages deliver.
 */
export function flushTtsToolAttachments(params: {
  runId: string | undefined;
  sessionKey?: string;
  deviceId: string;
  text: string;
  result: unknown;
  logLine: LogFn;
}): void {
  const runId = params.runId;
  if (!runId || runId === "(unknown)") return;

  const candidates = new Set<string>();
  for (const p of collectMediaPathsFromToolResult(params.result)) candidates.add(p);
  for (const p of extractLocalPathsFromToolTextBlob(params.text)) candidates.add(p);

  if (candidates.size === 0) {
    params.logLine("TTS_ATTACHMENT_NO_PATHS");
    return;
  }

  const unresolved: string[] = [];
  const resolved: Array<{ fileName: string; url: string }> = [];
  for (const p of candidates) {
    const r = resolveMediaAttachment(p);
    if (!r) {
      unresolved.push(p);
      continue;
    }
    // Bind local path + Friday URL so deliver() history does not double-append the same audio.
    if (!tryClaimOutboundMediaGroup(runId, [p, r.url])) continue;
    resolved.push(r);
  }

  if (resolved.length === 0) {
    if (unresolved.length > 0) {
      params.logLine(`TTS_ATTACHMENT_UNRESOLVED paths=${JSON.stringify(unresolved)}`);
    } else {
      params.logLine("TTS_SOURCE_DEDUPE_SKIP all_paths_seen_by_sendMedia_or_prior");
    }
    return;
  }

  const novelUrls = markNovelTtsUrls(runId, resolved.map((x) => x.url));
  if (novelUrls.length === 0) {
    params.logLine(`TTS_ATTACHMENT_DUPLICATE_SKIP resolved=${resolved.length}`);
    return;
  }
  const novelSet = new Set(novelUrls);
  const novelAttachments = resolved.filter((x) => novelSet.has(x.url));
  const audioAsVoice = readAudioAsVoiceFromTtsResult(params.result);

  sseEmitter.broadcast(
    {
      type: "tts",
      data: {
        attachments: novelAttachments,
        runId,
        deviceId: params.deviceId,
        timestamp: Date.now(),
        ...(audioAsVoice ? { audioAsVoice: true } : {}),
      },
    },
    params.deviceId,
    true,
  );
  params.logLine(`TTS_SSE_SENT count=${novelAttachments.length} audioAsVoice=${audioAsVoice}`);

  const historySk =
    (params.sessionKey?.trim() && resolveFridayHistorySessionKey(params.sessionKey.trim())) ??
    latestHistorySessionKeyForDeviceId(params.deviceId);
  if (!historySk) {
    params.logLine("TTS_ATTACHMENT_HISTORY_SKIP no_sessionKey");
    return;
  }

  let runIdForHist = runId;
  const hist = getHistory(historySk);
  if (hist && !hist.rounds.some((r) => r.runId === runIdForHist)) {
    const alt = sseEmitter.getLastRunIdForDevice(params.deviceId);
    if (alt && hist.rounds.some((r) => r.runId === alt)) {
      runIdForHist = alt;
    }
  }

  appendAssistantBlock({
    sessionKey: historySk,
    runId: runIdForHist,
    text: "",
    mediaUrls: novelUrls,
    attachments: novelAttachments,
    isError: false,
    mediaMessageType: "tts",
  });
}
