/**
 * Conversation history for the Friday channel.
 *
 * Stores the latest 20 rounds per session (grouped by runId).
 * Each round keeps stream-like messages and adds `role` to distinguish
 * user vs assistant.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { toSessionStoreKey } from "./session/session-manager.js";
import { sseEmitter } from "./sse/emitter.js";

const MAX_ROUNDS = 20;


// ── Data types ────────────────────────────────────────────────────────────────

export interface HistoryStreamMessage {
  role: "user" | "assistant";
  type: string;
  runId: string;
  timestamp: number;
  phase?: "start" | "delta" | "end" | "result" | "error";
  text?: string;
  mediaUrls?: string[];
  fileName?: string;
  isError?: boolean;
  error?: string;
  toolName?: string;
  params?: unknown;
  toolCallId?: string;
  durationMs?: number | null;
}

export interface ConversationRound {
  runId: string;
  messages: HistoryStreamMessage[];
  updatedAt: number;
  status: "streaming" | "completed" | "error";
  /** From OpenClaw `sessions.json` after the run (same session key). */
  model?: string;
  totalTokens?: number;
}

export interface ConversationSession {
  sessionKey: string;
  rounds: ConversationRound[];
  updatedAt: number;
}

export interface HistoryEventPayload {
  type: "history";
  sessionKey: string;
  rounds: ConversationRound[];
  timestamp: number;
}

// ── In-memory store ─────────────────────────────────────────────────────────

const sessions = new Map<string, ConversationSession>(); // keyed by sessionKey

// ── Persistence ─────────────────────────────────────────────────────────────

const HISTORY_DIR = path.join(os.homedir(), ".openclaw", "agents", "main", "sessions", "friday-history");
const HISTORY_INDEX = path.join(HISTORY_DIR, "index.json");
const OPENCLAW_SESSIONS_FILE = path.join(os.homedir(), ".openclaw", "agents", "main", "sessions", "sessions.json");

function fallbackFileNamesFromUrls(urls: string[]): string[] {
  return urls.map((u) => {
    const last = u.split("/").filter(Boolean).pop() ?? u;
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  });
}

function fallbackFileNameFromUrl(url: string): string {
  return fallbackFileNamesFromUrls([url])[0] ?? "";
}

function readOpenClawSessionsEntry(sessionKey: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(OPENCLAW_SESSIONS_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(OPENCLAW_SESSIONS_FILE, "utf-8")) as Record<string, Record<string, unknown>>;
    const fileKey = toSessionStoreKey(sessionKey);
    const row =
      raw[fileKey] ??
      raw[fileKey.toLowerCase()] ??
      raw[fileKey.toUpperCase()];
    return row && typeof row === "object" ? row : null;
  } catch {
    return null;
  }
}

function usageFieldsFromOpenClawRow(row: Record<string, unknown> | null): { model?: string; totalTokens?: number } {
  if (!row) return {};
  const model = typeof row.model === "string" && row.model.length > 0 ? row.model : undefined;
  const totalTokens = typeof row.totalTokens === "number" && Number.isFinite(row.totalTokens) ? row.totalTokens : undefined;
  return { model, totalTokens };
}

/** Copy model + totalTokens from OpenClaw session store onto the round; persist if anything changed. */
function applyUsageToRound(sessionKey: string, runId: string): void {
  const session = getHistory(sessionKey);
  if (!session) return;
  const round = session.rounds.find((r) => r.runId === runId);
  if (!round) return;
  const { model, totalTokens } = usageFieldsFromOpenClawRow(readOpenClawSessionsEntry(sessionKey));
  let changed = false;
  if (model !== undefined) {
    round.model = model;
    changed = true;
  }
  if (totalTokens !== undefined) {
    round.totalTokens = totalTokens;
    changed = true;
  }
  if (changed) {
    session.updatedAt = Date.now();
    persistSession(session);
  }
}

function ensureHistoryDir(): void {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  } catch {
    // Already exists or permission denied
  }
}

function persistSession(session: ConversationSession): void {
  try {
    ensureHistoryDir();
    const filePath = path.join(HISTORY_DIR, `${session.sessionKey}.json`);
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), "utf-8");
    // Update index
    const index = loadIndex();
    if (!index.includes(session.sessionKey)) {
      index.push(session.sessionKey);
      fs.writeFileSync(HISTORY_INDEX, JSON.stringify(index), "utf-8");
    }
  } catch {
    // Best-effort persistence
  }
}

function loadIndex(): string[] {
  try {
    if (fs.existsSync(HISTORY_INDEX)) {
      return JSON.parse(fs.readFileSync(HISTORY_INDEX, "utf-8")) as string[];
    }
  } catch {
    // ignore
  }
  return [];
}

function loadSession(sessionKey: string): ConversationSession | null {
  try {
    const filePath = path.join(HISTORY_DIR, `${sessionKey}.json`);
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
      return normalizeSession(sessionKey, parsed);
    }
  } catch {
    // ignore
  }
  return null;
}

/** Disk filenames for Friday sessions often use uppercase UUID; callers may use any case. */
function fridayHistoryDiskLookupKeys(preferred: string): string[] {
  const k = preferred.trim();
  const out: string[] = [];
  const push = (s: string) => {
    if (s && !out.includes(s)) out.push(s);
  };
  push(k);
  push(k.toLowerCase());
  const mMain = k.match(/^agent:main:friday-(.+)$/i);
  if (mMain?.[1]) {
    const id = mMain[1];
    push(`agent:main:friday-${id.toUpperCase()}`);
    push(`agent:main:friday-${id.toLowerCase()}`);
  }
  const mDirect = k.match(/^agent:main:friday:direct:(.+)$/i);
  if (mDirect?.[1]) {
    const id = mDirect[1];
    push(`agent:main:friday:direct:${id.toUpperCase()}`);
    push(`agent:main:friday:direct:${id.toLowerCase()}`);
  }
  const mBare = k.match(/^friday-(.+)$/i);
  if (mBare?.[1]) {
    const id = mBare[1];
    push(`friday-${id.toUpperCase()}`);
    push(`friday-${id.toLowerCase()}`);
  }
  return out;
}

function normalizeSession(sessionKey: string, raw: unknown): ConversationSession | null {
  const obj = raw as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") return null;
  const roundsRaw = Array.isArray(obj.rounds) ? obj.rounds : [];
  const rounds: ConversationRound[] = [];

  for (const rr of roundsRaw) {
    const ro = rr as Record<string, unknown>;
    const runId = typeof ro.runId === "string" ? ro.runId : "";
    if (!runId) continue;

    // New format
    if (Array.isArray(ro.messages)) {
      const messages: HistoryStreamMessage[] = ro.messages
        .map((m) => m as Record<string, unknown>)
        .filter((m) => m && typeof m === "object")
        .map((m) => ({
          role: m.role === "user" ? "user" : "assistant",
          type: typeof m.type === "string" ? m.type : "final",
          runId,
          timestamp: typeof m.timestamp === "number" ? m.timestamp : Date.now(),
          phase: typeof m.phase === "string" ? m.phase as HistoryStreamMessage["phase"] : undefined,
          text: typeof m.text === "string" ? m.text : undefined,
          mediaUrls: Array.isArray(m.mediaUrls) ? m.mediaUrls.filter((x) => typeof x === "string") as string[] : undefined,
          fileName: typeof m.fileName === "string" ? m.fileName : undefined,
          isError: typeof m.isError === "boolean" ? m.isError : undefined,
          error: typeof m.error === "string" ? m.error : undefined,
          toolName: typeof m.toolName === "string" ? m.toolName : undefined,
          params: m.params,
          toolCallId: typeof m.toolCallId === "string" ? m.toolCallId : undefined,
          durationMs: typeof m.durationMs === "number" ? m.durationMs : null,
        }));
      rounds.push({
        runId,
        messages,
        updatedAt: typeof ro.updatedAt === "number" ? ro.updatedAt : Date.now(),
        status: ro.status === "completed" || ro.status === "error" ? ro.status : "streaming",
        model: typeof ro.model === "string" ? ro.model : undefined,
        totalTokens: typeof ro.totalTokens === "number" ? ro.totalTokens : undefined,
      });
      continue;
    }

    // Legacy format migration
    const user = ro.user as Record<string, unknown> | undefined;
    const assistant = ro.assistant as Record<string, unknown> | undefined;
    const migrated: HistoryStreamMessage[] = [];
    if (user && typeof user.text === "string") {
      migrated.push({
        role: "user",
        type: "final",
        phase: "delta",
        runId,
        text: user.text,
        mediaUrls: Array.isArray(user.attachments) ? user.attachments.filter((x) => typeof x === "string") as string[] : [],
        timestamp: typeof user.timestamp === "number" ? user.timestamp : Date.now(),
      });
    }
    if (assistant && Array.isArray(assistant.messages)) {
      for (const msg of assistant.messages as Array<Record<string, unknown>>) {
        migrated.push({
          role: "assistant",
          type: "block",
          runId,
          text: typeof msg.text === "string" ? msg.text : "",
          mediaUrls: Array.isArray(msg.attachments) ? msg.attachments.filter((x) => typeof x === "string") as string[] : [],
          timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
        });
      }
    }
    rounds.push({
      runId,
      messages: migrated,
      updatedAt: Date.now(),
      status: ro.status === "completed" || ro.status === "error" ? ro.status : "streaming",
    });
  }

  return {
    sessionKey,
    rounds: rounds.slice(0, MAX_ROUNDS),
    updatedAt: typeof obj.updatedAt === "number" ? obj.updatedAt : Date.now(),
  };
}

function loadAllSessions(): void {
  ensureHistoryDir();
  try {
    const index = loadIndex();
    for (const sessionKey of index) {
      const session = loadSession(sessionKey);
      if (session) {
        sessions.set(sessionKey, session);
      }
    }
  } catch {
    // ignore
  }
}

// Load on module init
loadAllSessions();

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new conversation round for a user message.
 * Called synchronously on POST /friday/messages before the agent runs.
 */
export function createRound(params: {
  sessionKey: string;
  runId: string;
  userText: string;
  attachments: string[];
  attachmentItems?: Array<{ url: string; fileName: string }>;
}): ConversationRound {
  const { sessionKey, runId, userText, attachments, attachmentItems = [] } = params;
  const now = Date.now();
  const attachmentFileNameMap = new Map<string, string>();
  for (const item of attachmentItems) {
    attachmentFileNameMap.set(item.url, item.fileName);
  }

  let session = sessions.get(sessionKey);
  if (!session) {
    session = { sessionKey, rounds: [], updatedAt: now };
    sessions.set(sessionKey, session);
  }

  const round: ConversationRound = {
    runId,
    messages: [{
      role: "user",
      type: "final",
      phase: "delta",
      runId,
      text: userText,
      mediaUrls: attachments,
      fileName: attachments.length > 0
        ? (attachmentFileNameMap.get(attachments[0]) ?? fallbackFileNameFromUrl(attachments[0]))
        : undefined,
      timestamp: now,
    }],
    updatedAt: now,
    status: "streaming",
  };

  // Prepend (newest first), trim to MAX_ROUNDS
  session.rounds.unshift(round);
  session.updatedAt = now;
  if (session.rounds.length > MAX_ROUNDS) {
    session.rounds = session.rounds.slice(0, MAX_ROUNDS);
  }

  persistSession(session);

  return round;
}

/**
 * Start a round after /new or /reset: same as createRound but no user message (command text omitted from history).
 */
export function createAssistantOnlyRound(params: { sessionKey: string; runId: string }): ConversationRound {
  const { sessionKey, runId } = params;
  const now = Date.now();
  let session = sessions.get(sessionKey);
  if (!session) {
    session = { sessionKey, rounds: [], updatedAt: now };
    sessions.set(sessionKey, session);
  }

  const round: ConversationRound = {
    runId,
    messages: [],
    updatedAt: now,
    status: "streaming",
  };

  session.rounds.unshift(round);
  session.updatedAt = now;
  if (session.rounds.length > MAX_ROUNDS) {
    session.rounds = session.rounds.slice(0, MAX_ROUNDS);
  }

  persistSession(session);
  return round;
}

/**
 * Append a reasoning text update to the current streaming round.
 */
export function appendReasoning(params: {
  sessionKey: string;
  runId: string;
  reasoning: string;
}): void {
  const session = sessions.get(params.sessionKey);
  if (!session) return;
  const round = session.rounds.find((r) => r.runId === params.runId);
  if (!round || round.status !== "streaming") return;

  round.messages.push({
    role: "assistant",
    type: "reasoning",
    phase: "delta",
    runId: params.runId,
    text: params.reasoning,
    timestamp: Date.now(),
  });
  round.updatedAt = Date.now();
  session.updatedAt = Date.now();
  persistSession(session);
}

/**
 * Append a reasoning end marker (dumps reasoning into a hidden message).
 */
export function endReasoning(params: { sessionKey: string; runId: string }): void {
  const session = sessions.get(params.sessionKey);
  if (!session) return;
  const round = session.rounds.find((r) => r.runId === params.runId);
  if (!round || round.status !== "streaming") return;
  round.messages.push({
    role: "assistant",
    type: "reasoning",
    phase: "end",
    runId: params.runId,
    timestamp: Date.now(),
  });
  round.updatedAt = Date.now();
  session.updatedAt = Date.now();
  persistSession(session);
}

/**
 * Append assistant output to history without using "block" type.
 */
function isAssistantMediaHistoryType(t: string): boolean {
  return t === "attachment" || t === "tts";
}

function fridayFilesUrlToken(url: string): string | null {
  const s = url.trim();
  const mAbs = s.match(/^https?:\/\/[^/]+\/friday\/files\/([^/?#]+)/i);
  const mRel = s.match(/\/friday\/files\/([^/?#]+)/i);
  const enc = mAbs?.[1] ?? mRel?.[1];
  if (!enc) return null;
  try {
    return decodeURIComponent(enc);
  } catch {
    return enc;
  }
}

/** Same Friday-served file may appear under slightly different URL strings; dedupe by path token. */
function roundAlreadyHasFridayMediaToken(round: ConversationRound, url: string): boolean {
  const tok = fridayFilesUrlToken(url);
  if (!tok) return false;
  return round.messages.some((m) => {
    if (m.role !== "assistant" || !isAssistantMediaHistoryType(m.type)) return false;
    return m.mediaUrls?.some((u) => fridayFilesUrlToken(u) === tok) ?? false;
  });
}

function roundHasSameMediaAttachmentUrl(round: ConversationRound, urls: string[]): boolean {
  if (urls.length !== 1) return false;
  const only = urls[0];
  return round.messages.some(
    (m) =>
      m.role === "assistant" &&
      isAssistantMediaHistoryType(m.type) &&
      m.mediaUrls &&
      m.mediaUrls.length === 1 &&
      m.mediaUrls[0] === only,
  );
}

export function appendAssistantBlock(params: {
  sessionKey: string;
  runId: string;
  text: string;
  mediaUrls: string[];
  attachments?: Array<{ url: string; fileName: string }>;
  isError: boolean;
  /** History row `type` for each media item; defaults to `"attachment"`. */
  mediaMessageType?: "attachment" | "tts";
}): void {
  const session = sessions.get(params.sessionKey);
  if (!session) return;
  const round = session.rounds.find((r) => r.runId === params.runId);
  if (!round || round.status === "error") return;

  const hasText = Boolean(params.text && params.text.length > 0);
  const hasMedia = params.mediaUrls.length > 0;
  // Parent turn often completes before subagent-driven `message` tool finishes; attachments still need history.
  if (round.status === "completed") {
    if (!hasMedia || hasText) return;
  } else if (round.status !== "streaming") {
    return;
  }

  const now = Date.now();
  if (hasText && round.status === "streaming") {
    round.messages.push({
      role: "assistant",
      type: "final",
      runId: params.runId,
      text: params.text,
      isError: params.isError,
      timestamp: now,
    });
  }
  if (hasMedia) {
    const mediaRowType = params.mediaMessageType === "tts" ? "tts" : "attachment";
    const attachmentFileNameMap = new Map<string, string>();
    for (const item of params.attachments ?? []) {
      attachmentFileNameMap.set(item.url, item.fileName);
    }
    // One TTS clip per user round: `deliver(block)` + `deliver(final)` often carry the same audio
    // under different URL shapes; `flushTtsToolAttachments` may also write after tool end.
    const skipAllTtsMedia =
      mediaRowType === "tts" &&
      round.messages.some((m) => m.role === "assistant" && m.type === "tts");
    if (!skipAllTtsMedia) {
      for (const url of params.mediaUrls) {
        if (roundHasSameMediaAttachmentUrl(round, [url])) continue;
        if (roundAlreadyHasFridayMediaToken(round, url)) continue;
        round.messages.push({
          role: "assistant",
          type: mediaRowType,
          runId: params.runId,
          mediaUrls: [url],
          fileName: attachmentFileNameMap.get(url) ?? fallbackFileNameFromUrl(url),
          isError: params.isError,
          timestamp: now,
        });
      }
    }
  }
  round.updatedAt = now;
  session.updatedAt = now;
  persistSession(session);
}

export function appendToolEvent(params: {
  sessionKey: string;
  runId: string;
  phase: "start" | "end" | "error";
  toolName: string;
  params?: unknown;
  toolCallId?: string;
  text?: string;
  error?: string | null;
  durationMs?: number | null;
  /** When `runId` is an internal id, fall back to the device’s last POST turn runId. */
  deviceId?: string;
}): void {
  const session = getHistory(params.sessionKey);
  if (!session) return;
  let round = session.rounds.find((r) => r.runId === params.runId);
  if (!round && params.deviceId) {
    const alt = sseEmitter.getLastRunIdForDevice(params.deviceId);
    if (alt) {
      round = session.rounds.find((r) => r.runId === alt);
    }
  }
  if (!round) return;
  const runIdForMessage = round.runId;
  const now = Date.now();
  round.messages.push({
    role: "assistant",
    type: "tool",
    phase: params.phase,
    runId: runIdForMessage,
    timestamp: now,
    toolName: params.toolName,
    params: params.params,
    toolCallId: params.toolCallId,
    text: params.text,
    error: params.error ?? undefined,
    durationMs: params.durationMs ?? null,
  });
  round.updatedAt = now;
  session.updatedAt = now;
  persistSession(session);
}

/**
 * Append assistant text that arrives after the parent turn completed (e.g. sub-agent announce),
 * or when the round is no longer `streaming`. Uses the user's message `runId` from POST.
 */
export function appendLateAssistantText(params: {
  sessionKey: string;
  parentRunId: string;
  text: string;
}): void {
  const session = sessions.get(params.sessionKey);
  if (!session) return;
  const round = session.rounds.find((r) => r.runId === params.parentRunId);
  if (!round || !params.text) return;
  const now = Date.now();
  round.messages.push({
    role: "assistant",
    type: "final",
    phase: "delta",
    runId: params.parentRunId,
    text: params.text,
    timestamp: now,
  });
  round.updatedAt = now;
  session.updatedAt = now;
  persistSession(session);
}

/** Same as {@link appendLateAssistantText} for reasoning/thinking chunks after run-complete. */
export function appendLateReasoningDelta(params: {
  sessionKey: string;
  parentRunId: string;
  text: string;
}): void {
  const session = sessions.get(params.sessionKey);
  if (!session) return;
  const round = session.rounds.find((r) => r.runId === params.parentRunId);
  if (!round || !params.text) return;
  const now = Date.now();
  round.messages.push({
    role: "assistant",
    type: "reasoning",
    phase: "delta",
    runId: params.parentRunId,
    text: params.text,
    timestamp: now,
  });
  round.updatedAt = now;
  session.updatedAt = now;
  persistSession(session);
}

/**
 * Mark a round as completed.
 */
export function completeRound(params: { sessionKey: string; runId: string }): void {
  const session = getHistory(params.sessionKey);
  if (!session) return;
  const round = session.rounds.find((r) => r.runId === params.runId);
  if (!round) return;
  round.status = "completed";
  round.updatedAt = Date.now();
  session.updatedAt = Date.now();
  persistSession(session);
  applyUsageToRound(params.sessionKey, params.runId);
  setImmediate(() => applyUsageToRound(params.sessionKey, params.runId));
  setTimeout(() => applyUsageToRound(params.sessionKey, params.runId), 1200);
  setTimeout(() => applyUsageToRound(params.sessionKey, params.runId), 5000);
}

/**
 * Mark a round as errored.
 */
export function errorRound(params: { sessionKey: string; runId: string; error: string }): void {
  const session = getHistory(params.sessionKey);
  if (!session) return;
  const round = session.rounds.find((r) => r.runId === params.runId);
  if (!round) return;
  round.status = "error";
  round.messages.push({
    role: "assistant",
    type: "run-error",
    phase: "error",
    runId: params.runId,
    error: params.error,
    timestamp: Date.now(),
  });
  round.updatedAt = Date.now();
  session.updatedAt = Date.now();
  persistSession(session);
  applyUsageToRound(params.sessionKey, params.runId);
  setImmediate(() => applyUsageToRound(params.sessionKey, params.runId));
  setTimeout(() => applyUsageToRound(params.sessionKey, params.runId), 1200);
  setTimeout(() => applyUsageToRound(params.sessionKey, params.runId), 5000);
}

/**
 * Get conversation history for a device.
 * Returns rounds in reverse chronological order (newest first).
 *
 * Loads from disk on cache miss (covers scripts without a prior gateway run, and keys not yet in `index.json`).
 * For `friday-` / `agent:main:friday-` keys, UUID segment is matched case-insensitively against filenames.
 */
export function getHistory(sessionKey: string): ConversationSession | null {
  const cached = sessions.get(sessionKey);
  if (cached) return cached;
  for (const key of fridayHistoryDiskLookupKeys(sessionKey)) {
    const disk = loadSession(key);
    if (disk) {
      sessions.set(key, disk);
      if (key !== sessionKey) {
        sessions.set(sessionKey, disk);
      }
      return disk;
    }
  }
  return null;
}

function normalizeMessageTypeAndPhase(msg: HistoryStreamMessage): HistoryStreamMessage {
  if (msg.type === "reasoning" || msg.type === "final") {
    return { ...msg, phase: undefined };
  }
  if (msg.type === "tool" && msg.phase === "start") {
    return { ...msg, type: "toolcall", phase: undefined };
  }
  if (msg.type === "tool" && msg.phase === "end") {
    return { ...msg, type: "toolresult", phase: undefined };
  }
  if (msg.type === "tool" && msg.phase === "error") {
    return { ...msg, type: "toolerror", phase: undefined };
  }
  return msg;
}

function normalizeRound(round: ConversationRound): ConversationRound {
  let currentReasoning = "";
  let reasoningTs = 0;
  let finalText = "";
  let finalTs = 0;
  const legacyAttachmentEntries: Array<{ url: string; fileName: string; timestamp: number }> = [];
  const out: HistoryStreamMessage[] = [];

  const flushReasoningSegment = (): void => {
    if (currentReasoning.length > 0) {
      out.push({
        role: "assistant",
        type: "reasoning",
        runId: round.runId,
        text: currentReasoning,
        timestamp: reasoningTs || round.updatedAt,
      });
      currentReasoning = "";
    }
  };

  for (const raw of round.messages) {
    const msg = normalizeMessageTypeAndPhase(raw);
    const rawPhase = (raw as HistoryStreamMessage).phase;

    // Hide user "/stop" control message from history output.
    if (msg.role === "user" && typeof msg.text === "string" && msg.text.trim() === "/stop") {
      continue;
    }

    if (msg.role === "assistant" && msg.type === "reasoning") {
      if (typeof msg.text === "string" && msg.text.length > 0) {
        currentReasoning = msg.text;
        reasoningTs = msg.timestamp;
      }
      if (rawPhase === "end") {
        flushReasoningSegment();
      }
      continue;
    }

    if (msg.role === "assistant" && msg.type === "final") {
      flushReasoningSegment();
      if (typeof msg.text === "string" && msg.text.length > 0) {
        finalText = msg.text;
        finalTs = msg.timestamp;
      }
      continue;
    }

    // Filter out run-complete in history output.
    if (msg.type === "run-complete") {
      continue;
    }

    // Convert legacy/internal block entries to final/attachment semantics.
    if (msg.role === "assistant" && msg.type === "block") {
      flushReasoningSegment();
      if (typeof msg.text === "string" && msg.text.length > 0 && finalText.length === 0) {
        finalText = msg.text;
        finalTs = msg.timestamp;
      }
      if (Array.isArray(msg.mediaUrls) && msg.mediaUrls.length > 0) {
        for (const url of msg.mediaUrls) {
          legacyAttachmentEntries.push({
            url,
            fileName: fallbackFileNameFromUrl(url),
            timestamp: msg.timestamp,
          });
        }
      }
      continue;
    }

    if (
      msg.role === "assistant" &&
      isAssistantMediaHistoryType(msg.type) &&
      Array.isArray(msg.mediaUrls) &&
      msg.mediaUrls.length > 1
    ) {
      for (const url of msg.mediaUrls) {
        out.push({
          ...msg,
          mediaUrls: [url],
          fileName: msg.fileName ?? fallbackFileNameFromUrl(url),
        });
      }
      continue;
    }

    flushReasoningSegment();
    out.push(msg);
  }

  flushReasoningSegment();

  if (finalText.length > 0) {
    out.push({
      role: "assistant",
      type: "final",
      runId: round.runId,
      text: finalText,
      timestamp: finalTs || round.updatedAt,
    });
  }

  if (legacyAttachmentEntries.length > 0) {
    for (const entry of legacyAttachmentEntries) {
      out.push({
        role: "assistant",
        type: "attachment",
        runId: round.runId,
        mediaUrls: [entry.url],
        fileName: entry.fileName,
        timestamp: entry.timestamp || round.updatedAt,
      });
    }
  }

  return {
    ...round,
    messages: out,
  };
}

/**
 * Build the `type: "history"` payload for HTTP/SSE clients.
 * Rounds are ordered oldest → newest (new round last); in-memory storage stays newest-first.
 */
export function getHistoryEvent(sessionKey: string): HistoryEventPayload {
  const session = getHistory(sessionKey);
  if (!session) {
    return {
      type: "history",
      sessionKey,
      rounds: [],
      timestamp: Date.now(),
    };
  }
  const newestFirst = session.rounds.slice(0, MAX_ROUNDS);
  return {
    type: "history",
    sessionKey,
    rounds: [...newestFirst].reverse().map(normalizeRound),
    timestamp: Date.now(),
  };
}

/**
 * Clear all conversation history for a session.
 */
export function clearHistory(sessionKey: string): void {
  sessions.delete(sessionKey);
  try {
    const filePath = path.join(HISTORY_DIR, `${sessionKey}.json`);
    // Write an empty session instead of deleting the file, so loadSession returns
    // a valid ConversationSession (not null) and the App's history refresh works.
    const emptySession: ConversationSession = {
      sessionKey,
      rounds: [],
      updatedAt: Date.now(),
    };
    fs.writeFileSync(filePath, JSON.stringify(emptySession, null, 2), "utf-8");
    const index = loadIndex().filter((key) => key !== sessionKey);
    fs.writeFileSync(HISTORY_INDEX, JSON.stringify(index), "utf-8");
  } catch {
    // best-effort
  }
}
