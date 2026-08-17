/**
 * Tracks agent runs that have emitted lifecycle `phase: start` without matching `end`/`error`.
 *
 * Indexed both by runId (status endpoint) and by canonical sessionKey (home-page processing
 * badges). Observation must run before Friday device routing so WebChat/Telegram runs still
 * land in the session map.
 */

import { toSessionStoreKey } from "../session/session-manager.js";

const activeRunIds = new Set<string>();
const sessionKeyByRunId = new Map<string, string>();
const runIdsBySessionKey = new Map<string, Set<string>>();

export type SessionActivityChange = {
  sessionKey: string;
  hasActiveRun: boolean;
};

function sessionHasRuns(key: string): boolean {
  return (runIdsBySessionKey.get(key)?.size ?? 0) > 0;
}

function canonicalizeSessionKey(raw: string | undefined): string | undefined {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return undefined;
  return toSessionStoreKey(trimmed);
}

export function observeAgentEventForActiveRuns(evt: {
  stream: string;
  runId: string;
  data: Record<string, unknown>;
  sessionKey?: string;
}): SessionActivityChange | undefined {
  if (evt.stream !== "lifecycle") return undefined;
  const runId = typeof evt.runId === "string" ? evt.runId.trim() : "";
  if (!runId) return undefined;
  const phase = evt.data?.phase;
  const incomingKey = canonicalizeSessionKey(evt.sessionKey);

  if (phase === "start") {
    activeRunIds.add(runId);
    const key = incomingKey ?? sessionKeyByRunId.get(runId);
    if (!key) return undefined;
    const wasActive = sessionHasRuns(key);
    sessionKeyByRunId.set(runId, key);
    let set = runIdsBySessionKey.get(key);
    if (!set) {
      set = new Set();
      runIdsBySessionKey.set(key, set);
    }
    set.add(runId);
    if (!wasActive) return { sessionKey: key, hasActiveRun: true };
    return undefined;
  }

  if (phase === "end" || phase === "error") {
    activeRunIds.delete(runId);
    const key = sessionKeyByRunId.get(runId) ?? incomingKey;
    sessionKeyByRunId.delete(runId);
    if (!key) return undefined;
    const set = runIdsBySessionKey.get(key);
    if (!set) return undefined;
    const wasActive = set.size > 0;
    set.delete(runId);
    if (set.size === 0) runIdsBySessionKey.delete(key);
    if (wasActive && set.size === 0) return { sessionKey: key, hasActiveRun: false };
    return undefined;
  }

  return undefined;
}

export function getActiveRunIds(): string[] {
  return [...activeRunIds];
}

export function getActiveSessionKeys(): string[] {
  return [...runIdsBySessionKey.keys()].sort((a, b) => a.localeCompare(b));
}

export function hasActiveSession(sessionKey: string): boolean {
  const key = canonicalizeSessionKey(sessionKey);
  return key !== undefined && sessionHasRuns(key);
}

export function getActiveRunCount(): number {
  return activeRunIds.size;
}

export function resetActiveRunsForTest(): void {
  activeRunIds.clear();
  sessionKeyByRunId.clear();
  runIdsBySessionKey.clear();
}
