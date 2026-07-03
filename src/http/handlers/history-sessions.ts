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

/** Bytes read from the head of a cron transcript to find its `[cron:…]` preamble. */
const CRON_TITLE_PREFIX_BYTES = 64 * 1024;

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

/**
 * Derives a scheduled-task title from the cron session's first user message,
 * which the core injects as `[cron:<jobId> <name>] <prompt> Current time: …`.
 * Returns the job `<name>` (primary) or the `<prompt>` (fallback); undefined if
 * the transcript is unreadable or doesn't match. Only the first user line is
 * parsed, so this is a bounded read.
 */
function cronTitleFromTranscript(entry: Record<string, unknown>, storePath: string): string | undefined {
  const filePath = resolveTranscriptPath(entry, storePath);
  if (!filePath) return undefined;
  // Bounded prefix read: the `[cron:…]` preamble is the transcript's FIRST user
  // message, so a small head always contains it — never read the whole run (these
  // files can be large and this fires per cron run on every session-list fetch).
  let content: string;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.allocUnsafe(CRON_TITLE_PREFIX_BYTES);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      content = buf.toString("utf-8", 0, bytes);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
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
    if (!message || message.role !== "user") continue;
    const text = userMessageText(message.content);
    if (!text) return undefined;
    // `[cron:<jobId> <name>] <prompt> Current time: …` — jobId has no spaces; the
    // name may. Prefer <name>, but a placeholder/empty name falls back to <prompt>
    // (its first line, before "Current time:").
    const m = text.match(/^\[cron:\S+\s+([^\]]+)\]\s*([\s\S]*?)(?:\s+Current time:|$)/);
    if (m) {
      const name = m[1]?.trim();
      const prompt = m[2]?.trim().split("\n")[0]?.trim();
      const nameUsable = name && !PLACEHOLDER_CRON_NAMES.has(name);
      // nameUsable implies name is truthy, so the trailing `|| prompt` is unreachable.
      return (nameUsable ? name : prompt) || name || undefined;
    }
    return undefined; // first user line isn't the cron preamble — no title
  }
  return undefined;
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

    // Cron sessions have no `displayName`; derive a scheduled-task title from the
    // injected `[cron:<id> <name>] <prompt>` preamble (name primary, prompt fallback).
    const title = isCron
      ? (cronTitleFromTranscript(entry, storePath) ??
         readString(entry.displayName) ??
         readString(entry.label))
      : (readString(entry.displayName) ?? readString(entry.label));

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
