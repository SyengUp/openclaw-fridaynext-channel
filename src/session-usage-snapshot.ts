/**
 * Stable DTO for Friday SSE `lifecycle` terminal frames (`data.sessionUsage`).
 * Populated from OpenClaw `SessionEntry` after `persistSessionUsageUpdate`.
 */

export type FridaySessionUsagePayload = {
  modelId?: string;
  modelProvider?: string;
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
    totalFresh?: boolean;
  };
  context?: {
    windowMax?: number;
    used?: number;
  };
  estimatedCostUsd?: number;
};

function finiteNonNeg(n: unknown): number | undefined {
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  const t = Math.trunc(n);
  return t >= 0 ? t : undefined;
}

function finiteCost(n: unknown): number | undefined {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
  return n;
}

/** Build a compact snapshot from a loaded session store entry (unknown shape). */
export function buildSessionUsageSnapshot(
  entry: Record<string, unknown>,
): FridaySessionUsagePayload | undefined {
  const payload: FridaySessionUsagePayload = {};

  const modelId = typeof entry.model === "string" ? entry.model.trim() : "";
  if (modelId) payload.modelId = modelId;

  const modelProvider = typeof entry.modelProvider === "string" ? entry.modelProvider.trim() : "";
  if (modelProvider) payload.modelProvider = modelProvider;

  const tokens: NonNullable<FridaySessionUsagePayload["tokens"]> = {};
  const input = finiteNonNeg(entry.inputTokens);
  const output = finiteNonNeg(entry.outputTokens);
  const cacheRead = finiteNonNeg(entry.cacheRead);
  const cacheWrite = finiteNonNeg(entry.cacheWrite);
  const total = finiteNonNeg(entry.totalTokens);
  if (input !== undefined) tokens.input = input;
  if (output !== undefined) tokens.output = output;
  if (cacheRead !== undefined) tokens.cacheRead = cacheRead;
  if (cacheWrite !== undefined) tokens.cacheWrite = cacheWrite;
  if (total !== undefined) tokens.total = total;
  if (entry.totalTokensFresh === true) tokens.totalFresh = true;
  if (Object.keys(tokens).length > 0) payload.tokens = tokens;

  const context: NonNullable<FridaySessionUsagePayload["context"]> = {};
  const windowMax = finiteNonNeg(entry.contextTokens);
  const used = finiteNonNeg(entry.totalTokens);
  if (windowMax !== undefined) context.windowMax = windowMax;
  if (used !== undefined) context.used = used;
  if (Object.keys(context).length > 0) payload.context = context;

  const cost = finiteCost(entry.estimatedCostUsd);
  if (cost !== undefined) payload.estimatedCostUsd = cost;

  if (
    !payload.modelId &&
    !payload.modelProvider &&
    !payload.tokens &&
    !payload.context &&
    payload.estimatedCostUsd === undefined
  ) {
    return undefined;
  }

  return payload;
}
