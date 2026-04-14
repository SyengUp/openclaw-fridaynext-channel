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
import { tryClaimOutboundMediaSource } from "../outbound-media-source-dedupe.js";

type LogFn = (detail: string) => void;

const pendingPathsByRun = new Map<string, Set<string>>();
const sentAttachmentUrlsByRun = new Map<string, Set<string>>();

function mergePaths(target: Set<string>, source: Set<string>): void {
  for (const p of source) target.add(p);
}

function toSet(raw: unknown): Set<string> {
  return collectMediaPathsFromToolResult(raw);
}

function rememberPaths(runId: string, raw: unknown): void {
  const next = toSet(raw);
  if (next.size === 0) return;
  const cur = pendingPathsByRun.get(runId) ?? new Set<string>();
  mergePaths(cur, next);
  pendingPathsByRun.set(runId, cur);
}

function markAndFilterNovelUrls(runId: string, urls: string[]): string[] {
  const sent = sentAttachmentUrlsByRun.get(runId) ?? new Set<string>();
  const novel: string[] = [];
  for (const u of urls) {
    if (sent.has(u)) continue;
    sent.add(u);
    novel.push(u);
  }
  sentAttachmentUrlsByRun.set(runId, sent);
  if (sentAttachmentUrlsByRun.size > 2000) {
    sentAttachmentUrlsByRun.clear();
  }
  return novel;
}

export function captureMessageToolCandidatePaths(runId: string | undefined, payload: unknown): void {
  if (!runId || runId === "(unknown)") return;
  rememberPaths(runId, payload);
}

export function flushMessageToolAttachments(params: {
  runId: string | undefined;
  sessionKey?: string;
  deviceId: string;
  text: string;
  result: unknown;
  eventParams?: unknown;
  logLine: LogFn;
}): void {
  const runId = params.runId;
  if (!runId || runId === "(unknown)") return;

  const candidates = new Set<string>();
  const pending = pendingPathsByRun.get(runId);
  if (pending) mergePaths(candidates, pending);
  mergePaths(candidates, toSet(params.result));
  mergePaths(candidates, toSet(params.text));
  if (params.eventParams !== undefined) mergePaths(candidates, toSet(params.eventParams));
  mergePaths(candidates, extractLocalPathsFromToolTextBlob(params.text));

  pendingPathsByRun.delete(runId);

  if (candidates.size === 0) {
    params.logLine("ATTACHMENT_NO_PATHS");
    return;
  }

  const claimedSources = [...candidates].filter((p) => tryClaimOutboundMediaSource(runId, p));
  if (claimedSources.length === 0) {
    params.logLine("ATTACHMENT_SOURCE_DEDUPE_SKIP all_paths_seen_by_sendMedia_or_prior");
    return;
  }

  const unresolved: string[] = [];
  const resolved = claimedSources
    .map((p) => {
      const r = resolveMediaAttachment(p);
      if (!r) unresolved.push(p);
      return r;
    })
    .filter((x): x is { fileName: string; url: string } => x !== null);

  if (resolved.length === 0) {
    params.logLine(`ATTACHMENT_UNRESOLVED paths=${JSON.stringify(unresolved)}`);
    return;
  }

  const novelUrls = markAndFilterNovelUrls(runId, resolved.map((x) => x.url));
  if (novelUrls.length === 0) {
    params.logLine(`ATTACHMENT_DUPLICATE_SKIP runSeen=${resolved.length}`);
    return;
  }
  const novelSet = new Set(novelUrls);
  const novelAttachments = resolved.filter((x) => novelSet.has(x.url));
  sseEmitter.broadcast(
    {
      type: "attachment",
      data: {
        attachments: novelAttachments,
        runId,
        deviceId: params.deviceId,
        timestamp: Date.now(),
      },
    },
    params.deviceId,
    true,
  );
  params.logLine(`ATTACHMENT_SENT count=${novelAttachments.length}`);

  const historySk =
    (params.sessionKey?.trim() && resolveFridayHistorySessionKey(params.sessionKey.trim())) ??
    latestHistorySessionKeyForDeviceId(params.deviceId);
  if (!historySk) {
    params.logLine("ATTACHMENT_HISTORY_SKIP no_sessionKey");
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
  });
}

