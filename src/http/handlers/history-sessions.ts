/**
 * GET /friday-next/history/sessions
 *
 * Lists every session across every configured agent (lightweight metadata only).
 * The Friday app uses this to surface sessions created on other platforms /
 * channels in its sidebar before lazily fetching each session's history.
 *
 * Session message bodies are intentionally NOT read here — that is the job of the
 * per-session history endpoint. We only read each agent's `sessions.json` via the
 * forward runtime (`loadSessionStore`), matching the read path already used for
 * terminal lifecycle forwards.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import { getFridayAgentForwardRuntime } from "../../agent-forward-runtime.js";
import { extractBearerToken } from "../middleware/auth.js";
import { resolveTranscriptPath } from "../../history/read-transcript.js";

const DEFAULT_AGENT_ID = "main";
const SAFE_AGENT_ID = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Cron sessions are durable (`agent:<id>:cron:<jobId>`) but there can be hundreds
 * of them. Only surface those with a run in the recent window so the app's home
 * "recent" list isn't flooded — the Friday app renders these as scheduled-task
 * pills that the user can open like any conversation.
 */
const CRON_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Placeholder cron job names — the generic default the core stamps on jobs the user
 * never named. Treated as "no name" so the pill title falls back to the prompt (so
 * distinct nameless jobs stay distinguishable instead of all reading "自动化").
 */
const PLACEHOLDER_CRON_NAMES = new Set(["自动化"]);

/**
 * Safety cap on how much of a cron transcript we read to derive its title + whether
 * it produced a visible reply. A run's final plain-text reply is its LAST assistant
 * record, so a head-only prefix would miss it on long runs — we read the whole file
 * (cron transcripts are a single scheduled run, bounded in practice to a few hundred
 * KB) but never more than this, guarding against a pathological giant transcript.
 */
const CRON_TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;

export interface FridayHistorySessionSummary {
  /** Canonical app session key, e.g. "agent:main:main". */
  sessionKey: string;
  agentId: string;
  sessionId?: string;
  updatedAt?: number;
  model?: string;
  title?: string;
}

/** Mirror of OpenClaw's `normalizeAgentId` (also used in agents-list.ts). */
function normalizeAgentId(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return DEFAULT_AGENT_ID;
  const lowered = trimmed.toLowerCase();
  if (SAFE_AGENT_ID.test(lowered)) return lowered;
  return (
    lowered
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Configured agent ids (deduped). Falls back to the implicit "main" agent. */
function resolveConfiguredAgentIds(config: Record<string, unknown> | undefined): string[] {
  const agents = config?.agents as Record<string, unknown> | undefined;
  const list = agents?.list as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(list) || list.length === 0) return [DEFAULT_AGENT_ID];
  const ids = new Set<string>();
  for (const agent of list) {
    if (agent && typeof agent === "object") ids.add(normalizeAgentId(agent.id));
  }
  if (ids.size === 0) ids.add(DEFAULT_AGENT_ID);
  return [...ids];
}

/** Build the canonical app session key from an agent + a raw sessions.json key. */
function toCanonicalSessionKey(agentId: string, storeKey: string): string {
  const key = storeKey.trim();
  if (key.toLowerCase().startsWith("agent:")) return key;
  return `agent:${agentId}:${key}`;
}

/** Session-id portion (everything after `agent:<id>:`). */
function sessionRest(canonicalKey: string): string {
  const m = canonicalKey.match(/^agent:[^:]+:(.+)$/);
  return (m?.[1] ?? canonicalKey).toLowerCase();
}

/**
 * Internal/system sessions that aren't user-facing conversations — mirrors what
 * OpenClaw's own `sessions.list` filters (global/unknown/phantom) plus
 * heartbeat / subagent / memory-dreaming runs.
 *
 * NOTE: `cron:` is deliberately NOT filtered here anymore — scheduled-task
 * sessions are surfaced (capped to the recent window in `readAgentSessions`) so
 * the app can list them as openable conversations. Heartbeats stay filtered (noise).
 */
function isInternalSessionKey(canonicalKey: string, storeKey: string): boolean {
  const k = storeKey.toLowerCase();
  if (k === "global" || k === "unknown") return true;
  const rest = sessionRest(canonicalKey);
  return (
    rest === "sessions" || // phantom agent-store entry
    rest.startsWith("subagent:") ||
    rest.startsWith("dreaming-narrative") ||
    rest === "heartbeat" ||
    rest.endsWith(":heartbeat")
  );
}

/** True for a durable scheduled-task session key (`agent:<id>:cron:<jobId>`). */
function isCronSessionKey(canonicalKey: string): boolean {
  return sessionRest(canonicalKey).startsWith("cron:");
}

interface CronTranscriptInfo {
  /** Scheduled-task title from the `[cron:<id> <name>]` preamble (name or prompt). */
  title?: string;
  /**
   * True if the run produced a VISIBLE assistant reply — an assistant message with
   * non-empty text or an image. False ⇒ the cron session opens blank in the app:
   * either only the injected `[cron:…]` preamble (which the app filters as machine
   * scaffolding), or a tool-only run whose work was delivered elsewhere / never
   * produced a plain-text reply (its answer, if any, went to the user's own chat via
   * the message tool — the cron session itself shows just a collapsed thought trace).
   * Such sessions must be dropped from the list.
   */
  hasVisibleReply: boolean;
}

/** True if an assistant record carries a user-visible reply (text or image). */
function assistantRecordHasVisibleReply(message: Record<string, unknown>): boolean {
  const content = message.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const type = (block as Record<string, unknown>).type;
      if (type === "text") {
        const t = (block as Record<string, unknown>).text;
        if (typeof t === "string" && t.trim()) return true;
      } else if (type === "image") {
        return true; // a produced image is visible content even without text
      }
      // tool_use / thinking / tool_result blocks are NOT visible replies — they only
      // populate the (collapsed) thought trace, so a tool-only turn reads as blank.
    }
  }
  return false;
}

/**
 * Single pass over a cron transcript deriving BOTH its scheduled-task title and
 * whether the run produced a visible reply the app renders as a bubble.
 *
 * Title: the core injects `[cron:<jobId> <name>] <prompt> Current time: …` as the
 * FIRST user message; we return `<name>` (primary) or `<prompt>` (fallback).
 *
 * Visible reply: the app filters the `[cron:…]` preamble AND renders only assistant
 * text/images as the bubble body (tools go to a collapsed thought trace). So a run
 * that produced no assistant text/image — an aborted run with a contentless turn, or
 * a tool-only run that delivered elsewhere — opens as a blank screen and is dropped.
 * The final reply is the LAST assistant record, so we scan the whole file (bounded)
 * with an early exit once a visible reply is confirmed.
 */
function inspectCronTranscript(entry: Record<string, unknown>, storePath: string): CronTranscriptInfo {
  const filePath = resolveTranscriptPath(entry, storePath);
  if (!filePath) return { hasVisibleReply: false };
  let content: string;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const toRead = Math.min(size, CRON_TRANSCRIPT_MAX_BYTES);
      const buf = Buffer.allocUnsafe(toRead);
      const bytes = fs.readSync(fd, buf, 0, toRead, 0);
      content = buf.toString("utf-8", 0, bytes);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { hasVisibleReply: false };
  }

  let title: string | undefined;
  let hasVisibleReply = false;
  let sawFirstUser = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      rec = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = rec.message as Record<string, unknown> | undefined;
    if (!message || typeof message.role !== "string") continue;
    const role = message.role.toLowerCase();

    if (role === "user" && !sawFirstUser) {
      sawFirstUser = true;
      // First user record = the core-injected cron preamble → title source (the app
      // filters it, so it never counts as a visible reply).
      // `[cron:<jobId> <name>] <prompt> Current time: …` — jobId has no spaces; the
      // name may. Prefer <name>; a placeholder/empty name falls back to <prompt>
      // (its first line, before "Current time:").
      const text = userMessageText(message.content);
      const m = text?.match(/^\[cron:\S+\s+([^\]]+)\]\s*([\s\S]*?)(?:\s+Current time:|$)/);
      if (m) {
        const name = m[1]?.trim();
        const prompt = m[2]?.trim().split("\n")[0]?.trim();
        const nameUsable = name && !PLACEHOLDER_CRON_NAMES.has(name);
        title = (nameUsable ? name : prompt) || name || undefined;
      }
      continue;
    }

    if (role === "assistant" && assistantRecordHasVisibleReply(message)) {
      hasVisibleReply = true;
      break; // the preamble is record 0, so the title is already captured
    }
  }
  return { title, hasVisibleReply };
}

/** Flattens a transcript message `content` (string or block array) to plain text. */
function userMessageText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
        const t = (block as Record<string, unknown>).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    const joined = parts.join(" ").trim();
    return joined || undefined;
  }
  return undefined;
}

/** A session counts as archived/empty when its transcript file is gone or empty. */
function hasLiveTranscript(entry: Record<string, unknown>, storePath: string): boolean {
  const filePath = resolveTranscriptPath(entry, storePath);
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false; // archived (moved to .deleted/.bak) or never written
  }
}

function readAgentSessions(agentId: string): FridayHistorySessionSummary[] {
  const rt = getFridayAgentForwardRuntime();
  if (!rt) return [];
  let storePath: string;
  let store: Record<string, unknown>;
  try {
    storePath = rt.resolveStorePath(undefined, { agentId });
    store = rt.loadSessionStore(storePath) ?? {};
  } catch {
    return [];
  }
  const summaries: FridayHistorySessionSummary[] = [];
  for (const [storeKey, rawEntry] of Object.entries(store)) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as Record<string, unknown>;
    const canonicalKey = toCanonicalSessionKey(agentId, storeKey);

    // Drop internal/system sessions and subagent links. We key only on
    // `spawnedBy`/`subagentRole` (plus the `subagent:` prefix in
    // isInternalSessionKey) — NOT on `parentSessionKey`, which real user
    // conversations (e.g. webchat sessions branched off another session) also
    // carry and which would otherwise be wrongly excluded from the sidebar.
    if (isInternalSessionKey(canonicalKey, storeKey)) continue;
    if (entry.spawnedBy || entry.subagentRole) continue;
    // Drop archived/empty sessions (transcript moved away or never written).
    if (!hasLiveTranscript(entry, storePath)) continue;

    const isCron = isCronSessionKey(canonicalKey);
    const updatedAt = readNumber(entry.updatedAt);
    // Cron sessions are surfaced only when they ran recently — there can be
    // hundreds otherwise. A cron session with no `updatedAt` is treated as stale.
    if (isCron && (updatedAt === undefined || Date.now() - updatedAt > CRON_RECENT_WINDOW_MS)) {
      continue;
    }

    // Cron sessions have no `displayName`; one transcript pass yields both the
    // scheduled-task title and whether the run produced a visible reply. Drop
    // "empty" cron runs — an aborted run with a contentless assistant turn, or a
    // tool-only run whose answer was delivered elsewhere — they open as a blank
    // screen in the app (only a collapsed thought trace, no bubble body).
    let title: string | undefined;
    if (isCron) {
      const info = inspectCronTranscript(entry, storePath);
      if (!info.hasVisibleReply) continue;
      title = info.title ?? readString(entry.displayName) ?? readString(entry.label);
    } else {
      title = readString(entry.displayName) ?? readString(entry.label);
    }

    summaries.push({
      sessionKey: canonicalKey,
      agentId,
      ...(readString(entry.sessionId) ? { sessionId: readString(entry.sessionId) } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...((readString(entry.model) ?? readString(entry.modelOverride))
        ? { model: readString(entry.model) ?? readString(entry.modelOverride) }
        : {}),
      ...(title ? { title } : {}),
    });
  }
  return summaries;
}

export async function handleHistorySessions(
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

  const rt = getFridayAgentForwardRuntime();
  const config = rt?.getConfig() as Record<string, unknown> | undefined;
  const agentIds = resolveConfiguredAgentIds(config);

  const sessions: FridayHistorySessionSummary[] = [];
  for (const agentId of agentIds) {
    sessions.push(...readAgentSessions(agentId));
  }
  const deduped = dedupeCronSessionsByTitle(sessions);
  deduped.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, sessions: deduped }));
  return true;
}

/**
 * Isolated cron jobs mint a NEW per-run session each firing, so a single job
 * (e.g. "每日天气简报") accumulates dozens of `agent:<id>:cron:<runId>` sessions —
 * there is no stable job id in the key to group by. Collapse them to ONE entry
 * per job, keyed by `agentId + title`, keeping the most recent run's session so
 * the app shows a single scheduled-task pill that opens the latest run. Non-cron
 * sessions are passed through untouched (distinct conversations may share a title).
 */
function dedupeCronSessionsByTitle(
  sessions: FridayHistorySessionSummary[],
): FridayHistorySessionSummary[] {
  const latestCronByJob = new Map<string, FridayHistorySessionSummary>();
  const out: FridayHistorySessionSummary[] = [];
  for (const s of sessions) {
    if (!isCronSessionKey(s.sessionKey)) {
      out.push(s);
      continue;
    }
    const jobKey = `${s.agentId} ${s.title ?? s.sessionKey}`;
    const existing = latestCronByJob.get(jobKey);
    if (!existing || (s.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
      latestCronByJob.set(jobKey, s);
    }
  }
  out.push(...latestCronByJob.values());
  return out;
}
