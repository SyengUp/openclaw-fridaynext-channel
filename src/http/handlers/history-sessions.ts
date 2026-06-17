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
 * OpenClaw's own `sessions.list` filters (cron/global/unknown/phantom) plus
 * heartbeat / subagent / memory-dreaming runs.
 */
function isInternalSessionKey(canonicalKey: string, storeKey: string): boolean {
  const k = storeKey.toLowerCase();
  if (k === "global" || k === "unknown") return true;
  const rest = sessionRest(canonicalKey);
  return (
    rest === "sessions" || // phantom agent-store entry
    rest.startsWith("subagent:") ||
    rest.startsWith("cron:") ||
    rest.startsWith("dreaming-narrative") ||
    rest === "heartbeat" ||
    rest.endsWith(":heartbeat")
  );
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

    summaries.push({
      sessionKey: canonicalKey,
      agentId,
      ...(readString(entry.sessionId) ? { sessionId: readString(entry.sessionId) } : {}),
      ...(readNumber(entry.updatedAt) !== undefined
        ? { updatedAt: readNumber(entry.updatedAt) }
        : {}),
      ...((readString(entry.model) ?? readString(entry.modelOverride))
        ? { model: readString(entry.model) ?? readString(entry.modelOverride) }
        : {}),
      // Server-side session display name (matches OpenClaw's resolution order).
      ...((readString(entry.displayName) ?? readString(entry.label))
        ? { title: readString(entry.displayName) ?? readString(entry.label) }
        : {}),
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
  sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, sessions }));
  return true;
}
