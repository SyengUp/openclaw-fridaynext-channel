import type { FridaySessionUsagePayload } from "../session-usage-snapshot.js";

type UsageFields = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

type AccumulatedUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  model?: string;
  provider?: string;
};

const usageByRunId = new Map<string, AccumulatedUsage>();

function ensure(runId: string): AccumulatedUsage {
  let entry = usageByRunId.get(runId);
  if (!entry) {
    entry = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    usageByRunId.set(runId, entry);
  }
  return entry;
}

export function accumulateRunUsage(
  runId: string,
  usage: UsageFields,
  model?: string,
  provider?: string,
): void {
  if (!runId.trim()) return;
  const entry = ensure(runId);
  if (typeof usage.input === "number" && usage.input > 0) entry.input += usage.input;
  if (typeof usage.output === "number" && usage.output > 0) entry.output += usage.output;
  if (typeof usage.cacheRead === "number" && usage.cacheRead > 0)
    entry.cacheRead += usage.cacheRead;
  if (typeof usage.cacheWrite === "number" && usage.cacheWrite > 0)
    entry.cacheWrite += usage.cacheWrite;
  if (typeof usage.total === "number" && usage.total > 0) entry.total += usage.total;
  if (model && model.trim()) entry.model = model.trim();
  if (provider && provider.trim()) entry.provider = provider.trim();
}

export function consumeRunUsage(runId: string): FridaySessionUsagePayload | undefined {
  const entry = usageByRunId.get(runId);
  if (!entry) return undefined;
  usageByRunId.delete(runId);
  const tokens: NonNullable<FridaySessionUsagePayload["tokens"]> = {};
  if (entry.input > 0) tokens.input = entry.input;
  if (entry.output > 0) tokens.output = entry.output;
  if (entry.cacheRead > 0) tokens.cacheRead = entry.cacheRead;
  if (entry.cacheWrite > 0) tokens.cacheWrite = entry.cacheWrite;
  if (entry.total > 0) tokens.total = entry.total;
  tokens.totalFresh = true;
  if (Object.keys(tokens).length === 1) return undefined; // only totalFresh, no actual tokens
  const payload: FridaySessionUsagePayload = { tokens };
  if (entry.model) payload.modelId = entry.model;
  if (entry.provider) payload.modelProvider = entry.provider;
  return payload;
}

/** Vitest-only. */
export function resetRunUsageAccumulatorForTest(): void {
  usageByRunId.clear();
}
