type RunRoute = {
  runId: string;
  deviceId: string;
  sessionKey: string;
};

export type RunMetadata = {
  modelName?: string;
  modelProvider?: string;
  totalTokens?: number;
  /** Detailed token breakdown captured from agent event usage (current run, not stale store read). */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

const runRouteById = new Map<string, RunRoute>();
const runMetadataById = new Map<string, RunMetadata>();
const finalDeliveredRunIds = new Set<string>();

/** Vitest / harness: clears per-run metadata and final-delivered flags (not routes). */
export function resetRunMetadataForTest(): void {
  runMetadataById.clear();
  finalDeliveredRunIds.clear();
}

export function registerRunRoute(route: RunRoute): void {
  if (!route.runId.trim()) return;
  runRouteById.set(route.runId, route);
}

export function getRunRoute(runId: string): RunRoute | undefined {
  return runRouteById.get(runId);
}

export function setRunMetadata(runId: string, metadata: RunMetadata): void {
  if (!runId.trim()) return;
  const existing = runMetadataById.get(runId) ?? {};
  runMetadataById.set(runId, { ...existing, ...metadata });
}

export function getRunMetadata(runId: string): RunMetadata | undefined {
  return runMetadataById.get(runId);
}

export function markRunFinalDelivered(runId: string): void {
  if (!runId.trim()) return;
  finalDeliveredRunIds.add(runId);
}

export function hasRunFinalDelivered(runId: string): boolean {
  return finalDeliveredRunIds.has(runId);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function pickInputTokens(u: Record<string, unknown>): number | undefined {
  return (
    finiteNumber(u.input) ??
    finiteNumber(u.inputTokens) ??
    finiteNumber(u.input_tokens) ??
    finiteNumber(u.promptTokens) ??
    finiteNumber(u.prompt_tokens) ??
    finiteNumber(u.prompt_n)
  );
}

function pickOutputTokens(u: Record<string, unknown>): number | undefined {
  return (
    finiteNumber(u.output) ??
    finiteNumber(u.outputTokens) ??
    finiteNumber(u.output_tokens) ??
    finiteNumber(u.completionTokens) ??
    finiteNumber(u.completion_tokens) ??
    finiteNumber(u.predicted_n)
  );
}

function pickCacheRead(u: Record<string, unknown>): number | undefined {
  const inDet = recordValue(u.input_tokens_details);
  const prDet = recordValue(u.prompt_tokens_details);
  return (
    finiteNumber(u.cacheRead) ??
    finiteNumber(u.cache_read) ??
    finiteNumber(u.cache_read_input_tokens) ??
    finiteNumber(u.cached_tokens) ??
    (inDet ? finiteNumber(inDet.cached_tokens) : undefined) ??
    (prDet ? finiteNumber(prDet.cached_tokens) : undefined)
  );
}

function pickCacheWrite(u: Record<string, unknown>): number | undefined {
  return (
    finiteNumber(u.cacheWrite) ??
    finiteNumber(u.cache_write) ??
    finiteNumber(u.cache_creation_input_tokens)
  );
}

export function ingestAgentEventMetadata(runId: string, data: Record<string, unknown>): void {
  if (!runId.trim()) return;
  const next: RunMetadata = {};
  const modelName =
    (typeof data.modelName === "string" && data.modelName.trim()) ||
    (typeof data.model === "string" && data.model.trim()) ||
    undefined;
  if (modelName) next.modelName = modelName;

  const modelProvider =
    (typeof data.modelProvider === "string" && data.modelProvider.trim()) ||
    (typeof data.provider === "string" && data.provider.trim()) ||
    undefined;
  if (modelProvider) next.modelProvider = modelProvider;

  const usage = recordValue(data.usage);
  const totalTokens =
    finiteNumber(data.totalTokens) ??
    finiteNumber(data.total_tokens) ??
    finiteNumber(usage?.totalTokens) ??
    finiteNumber(usage?.total_tokens) ??
    finiteNumber(usage?.total);
  if (typeof totalTokens === "number" && totalTokens > 0) {
    next.totalTokens = Math.floor(totalTokens);
  }

  const usageForTokens = usage ?? data;
  const input = pickInputTokens(usageForTokens);
  if (typeof input === "number" && input >= 0) next.inputTokens = Math.floor(input);
  const output = pickOutputTokens(usageForTokens);
  if (typeof output === "number" && output >= 0) next.outputTokens = Math.floor(output);
  const cacheRead = pickCacheRead(usageForTokens);
  if (typeof cacheRead === "number" && cacheRead >= 0) next.cacheReadTokens = Math.floor(cacheRead);
  const cacheWrite = pickCacheWrite(usageForTokens);
  if (typeof cacheWrite === "number" && cacheWrite >= 0)
    next.cacheWriteTokens = Math.floor(cacheWrite);

  if (
    next.modelName ||
    next.modelProvider ||
    typeof next.totalTokens === "number" ||
    typeof next.inputTokens === "number" ||
    typeof next.outputTokens === "number" ||
    typeof next.cacheReadTokens === "number" ||
    typeof next.cacheWriteTokens === "number"
  ) {
    setRunMetadata(runId, next);
  }
}
