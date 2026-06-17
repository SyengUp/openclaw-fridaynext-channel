export type SubagentStatus = "spawning" | "running" | "ended";

export type SubagentOutcome = "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";

export type SubagentEntry = {
  childSessionKey: string;
  runId?: string;
  parentRunId?: string;
  deviceId: string;
  label?: string;
  depth: number;
  status: SubagentStatus;
  outcome?: SubagentOutcome;
  error?: string;
};

export type SubagentMeta = {
  label?: string;
  parentRunId?: string;
  depth: number;
};

type SpawnIntent = {
  label?: string;
  parentRunId: string;
  deviceId: string;
  depth: number;
  requesterSessionKey?: string;
};

const byChildSessionKey = new Map<string, SubagentEntry>();
const byRunId = new Map<string, SubagentEntry>();
const byToolCallId = new Map<string, SpawnIntent>();
const sessionKeyToRunId = new Map<string, string>();

/** Called by forwardAgentEventRaw on lifecycle start so we can resolve parentRunId. */
export function registerSessionKeyForRun(sessionKey: string, runId: string): void {
  if (!sessionKey || !runId) return;
  sessionKeyToRunId.set(sessionKey, runId);
}

/**
 * Parse OpenClaw announce compound runId:
 *   announce:v<version>:<sessionKey>:<bareRunId>
 * Example:
 *   announce:v1:agent:main:subagent:uuid:runId
 *   → { childSessionKey: "agent:main:subagent:uuid", bareRunId: "runId" }
 */
const ANNOUNCE_RUN_ID_RE = /^announce:v\d+:(agent:.+?):([^:]+)$/;

function parseAnnounceRunId(runId: string): { childSessionKey: string; bareRunId: string } | null {
  const m = runId.match(ANNOUNCE_RUN_ID_RE);
  if (!m) return null;
  return { childSessionKey: m[1] ?? "", bareRunId: m[2] ?? "" };
}

/** Look up subagent entry by any runId form (announce compound or bare). */
export function lookupByRunId(runId: string): SubagentEntry | undefined {
  const direct = byRunId.get(runId);
  if (direct) return direct;
  const parsed = parseAnnounceRunId(runId);
  if (parsed) {
    const byChild = byChildSessionKey.get(parsed.childSessionKey);
    if (byChild) {
      // Also register the compound runId for future fast lookup
      byRunId.set(runId, byChild);
      return byChild;
    }
    return byRunId.get(parsed.bareRunId);
  }
  return undefined;
}

/** Look up subagent entry by childSessionKey. */
export function lookupByChildSessionKey(key: string): SubagentEntry | undefined {
  return byChildSessionKey.get(key);
}

/**
 * Called on sessions_spawn item.start (before tool execution).
 * Stores the spawn intent so spawning SSE can be emitted immediately.
 */
export function registerSpawnIntent(params: {
  toolCallId: string;
  label?: string;
  deviceId: string;
  parentRunId: string;
  requesterSessionKey?: string;
}): SpawnIntent {
  let depth = 1;
  if (params.requesterSessionKey) {
    const parent = byChildSessionKey.get(params.requesterSessionKey);
    if (parent) depth = parent.depth + 1;
  }
  const intent: SpawnIntent = {
    label: params.label,
    parentRunId: params.parentRunId,
    deviceId: params.deviceId.toUpperCase(),
    depth,
    requesterSessionKey: params.requesterSessionKey,
  };
  byToolCallId.set(params.toolCallId, intent);
  return intent;
}

/** Consume a previously registered spawn intent. Returns undefined if none. */
export function consumeSpawnIntent(toolCallId: string): SpawnIntent | undefined {
  const intent = byToolCallId.get(toolCallId);
  byToolCallId.delete(toolCallId);
  return intent;
}

/**
 * Called when forwardAgentEventRaw sees a sessions_spawn tool result.
 * Extracts childSessionKey, runId, taskName and registers the subagent.
 */
export function ensureSubagentFromSpawnTool(params: {
  childSessionKey: string;
  bareRunId?: string;
  label?: string;
  deviceId: string;
  parentRunId: string;
  requesterSessionKey?: string;
  depth?: number;
}): SubagentEntry {
  const existing = byChildSessionKey.get(params.childSessionKey);
  if (existing) {
    if (params.bareRunId && !existing.runId) {
      existing.runId = params.bareRunId;
      byRunId.set(params.bareRunId, existing);
      sessionKeyToRunId.set(params.childSessionKey, params.bareRunId);
    }
    existing.status = "running";
    return existing;
  }

  let depth = params.depth ?? 1;
  if (depth <= 1 && params.requesterSessionKey) {
    const parent = byChildSessionKey.get(params.requesterSessionKey);
    if (parent) depth = parent.depth + 1;
  }

  const entry: SubagentEntry = {
    childSessionKey: params.childSessionKey,
    runId: params.bareRunId,
    parentRunId: params.parentRunId,
    deviceId: params.deviceId.toUpperCase(),
    label: params.label || undefined,
    depth,
    status: "running",
  };
  byChildSessionKey.set(params.childSessionKey, entry);
  if (params.bareRunId) {
    byRunId.set(params.bareRunId, entry);
    sessionKeyToRunId.set(params.childSessionKey, params.bareRunId);
  }
  return entry;
}

/** Mark subagent as ended. Resolves by bare/compound runId or childSessionKey. */
export function registerEnded(params: {
  runId?: string;
  childSessionKey?: string;
  outcome?: SubagentOutcome;
  error?: string;
}): SubagentEntry | undefined {
  let entry: SubagentEntry | undefined;
  if (params.runId) entry = lookupByRunId(params.runId);
  if (!entry && params.childSessionKey) entry = byChildSessionKey.get(params.childSessionKey);
  if (!entry) return undefined;
  entry.status = "ended";
  if (params.outcome) entry.outcome = params.outcome;
  if (params.error) entry.error = params.error;
  return entry;
}

/** Extract subagent metadata for SSE annotation. */
export function subagentMeta(entry: SubagentEntry): SubagentMeta {
  return {
    label: entry.label,
    parentRunId: entry.parentRunId,
    depth: entry.depth,
  };
}

export function resetForTest(): void {
  byChildSessionKey.clear();
  byRunId.clear();
  byToolCallId.clear();
  sessionKeyToRunId.clear();
}
