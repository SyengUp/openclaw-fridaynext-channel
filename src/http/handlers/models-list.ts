import type { IncomingMessage, ServerResponse } from "node:http";
import { getFridayAgentForwardRuntime } from "../../agent-forward-runtime.js";
import { splitModelRef } from "../../session/session-manager.js";
import { resolveModelThinking, type ThinkingLevelOption } from "../../thinking-levels.js";
import { extractBearerToken } from "../middleware/auth.js";

export interface FridayModelEntry {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  /** Thinking levels this model supports (varies per model). Omitted when only the base set applies. */
  thinkingLevels?: ThinkingLevelOption[];
  /** Provider/model default thinking level, when the gateway reports one. */
  thinkingDefault?: string;
}

interface ResolvedModels {
  models: FridayModelEntry[];
  defaultModel: string;
}

function resolveConfiguredModels(): ResolvedModels {
  const rt = getFridayAgentForwardRuntime();
  if (!rt) return { models: [], defaultModel: "" };
  const cfg = rt.getConfig() as Record<string, unknown>;

  const providerMeta = buildProviderModelMeta(cfg);

  const agents = cfg?.agents as Record<string, unknown> | undefined;
  const agentDefaults = agents?.defaults as Record<string, unknown> | undefined;
  const agentModels = agentDefaults?.models as Record<string, Record<string, unknown>> | undefined;

  const seen = new Set<string>();
  const entries: FridayModelEntry[] = [];

  if (agentModels) {
    for (const [modelKey, info] of Object.entries(agentModels)) {
      const split = splitModelRef(modelKey);
      if (!split.provider) continue;
      const meta = providerMeta.get(modelKey);
      seen.add(modelKey);
      entries.push({
        id: modelKey,
        name: typeof info?.alias === "string" ? info.alias : meta?.name ?? split.modelId,
        provider: split.provider,
        reasoning: meta?.reasoning,
        contextWindow: meta?.contextWindow,
        maxTokens: meta?.maxTokens,
      });
    }
  }

  for (const agent of (agents?.list as Array<Record<string, unknown>> | undefined) ?? []) {
    const primaryModel = typeof agent?.model === "string" ? agent.model : undefined;
    if (primaryModel && !seen.has(primaryModel)) {
      const split = splitModelRef(primaryModel);
      const meta = providerMeta.get(primaryModel);
      entries.push({
        id: primaryModel,
        name: meta?.name ?? split.modelId,
        provider: split.provider ?? "",
        reasoning: meta?.reasoning,
        contextWindow: meta?.contextWindow,
        maxTokens: meta?.maxTokens,
      });
    }
  }

  const agentModel = agentDefaults?.model;
  let defaultModel =
    typeof agentModel === "string" && agentModel.trim()
      ? agentModel.trim()
      : typeof (agentModel as Record<string, unknown> | undefined)?.primary === "string"
        ? ((agentModel as Record<string, unknown>).primary as string)
        : "";

  if (!defaultModel && entries.length > 0) {
    defaultModel = entries[0].id;
  }

  if (defaultModel && !seen.has(defaultModel)) {
    const split = splitModelRef(defaultModel);
    const meta = providerMeta.get(defaultModel);
    entries.unshift({
      id: defaultModel,
      name: meta?.name ?? split.modelId,
      provider: split.provider ?? "",
      reasoning: meta?.reasoning,
      contextWindow: meta?.contextWindow,
      maxTokens: meta?.maxTokens,
    });
  }

  for (const entry of entries) {
    const split = splitModelRef(entry.id);
    const thinking = resolveModelThinking(entry.provider || split.provider, split.modelId);
    entry.thinkingLevels = thinking.levels;
    if (thinking.default) entry.thinkingDefault = thinking.default;
  }

  return { models: entries, defaultModel };
}

function buildProviderModelMeta(cfg: Record<string, unknown>): Map<string, {
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}> {
  const meta = new Map<string, { name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number }>();
  const models = cfg?.models as Record<string, unknown> | undefined;
  const providers = models?.providers as Record<string, unknown> | undefined;
  if (providers) {
    for (const [providerId, provider] of Object.entries(providers)) {
      const providerModels = (provider as { models?: Array<Record<string, unknown>> })?.models;
      if (!Array.isArray(providerModels)) continue;
      for (const m of providerModels) {
        const modelId = typeof m.id === "string" ? m.id : typeof m.name === "string" ? m.name : "";
        if (!modelId) continue;
        meta.set(`${providerId}/${modelId}`, {
          name: typeof m.name === "string" ? m.name : undefined,
          reasoning: typeof m.reasoning === "boolean" ? m.reasoning : undefined,
          contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
          maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : undefined,
        });
      }
    }
  }
  return meta;
}

export async function handleModelsList(
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

  const { models, defaultModel } = resolveConfiguredModels();

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, models, defaultModel }));
  return true;
}
