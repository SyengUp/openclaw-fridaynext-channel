import type { IncomingMessage, ServerResponse } from "node:http";
import { getFridayAgentForwardRuntime } from "../../agent-forward-runtime.js";
import { extractBearerToken } from "../middleware/auth.js";

export interface FridayModelEntry {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

function resolveConfiguredModels(): FridayModelEntry[] {
  const rt = getFridayAgentForwardRuntime();
  if (!rt) return [];
  const cfg = rt.getConfig() as Record<string, unknown>;

  // Build a lookup of provider-level model metadata
  const providerMeta = new Map<string, { name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number }>();
  const models = cfg?.models as Record<string, unknown> | undefined;
  const providers = models?.providers as Record<string, unknown> | undefined;
  if (providers) {
    for (const [providerId, provider] of Object.entries(providers)) {
      const providerModels = (provider as { models?: Array<Record<string, unknown>> })?.models;
      if (!Array.isArray(providerModels)) continue;
      for (const m of providerModels) {
        const modelId = typeof m.id === "string" ? m.id : typeof m.name === "string" ? m.name : "";
        if (!modelId) continue;
        const key = `${providerId}/${modelId}`;
        providerMeta.set(key, {
          name: typeof m.name === "string" ? m.name : undefined,
          reasoning: typeof m.reasoning === "boolean" ? m.reasoning : undefined,
          contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
          maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : undefined,
        });
      }
    }
  }

  // agents.defaults.models is the authoritative list of available models
  const agents = cfg?.agents as Record<string, unknown> | undefined;
  const agentDefaults = agents?.defaults as Record<string, unknown> | undefined;
  const agentModels = agentDefaults?.models as Record<string, Record<string, unknown>> | undefined;

  const seen = new Set<string>();
  const entries: FridayModelEntry[] = [];

  if (agentModels) {
    for (const [modelKey, info] of Object.entries(agentModels)) {
      const slashIdx = modelKey.indexOf("/");
      if (slashIdx <= 0) continue;
      const provider = modelKey.slice(0, slashIdx);
      const modelId = modelKey.slice(slashIdx + 1);
      const meta = providerMeta.get(modelKey);
      seen.add(modelKey);
      entries.push({
        id: modelKey,
        name: typeof info?.alias === "string" ? info.alias : meta?.name ?? modelId,
        provider,
        reasoning: meta?.reasoning,
        contextWindow: meta?.contextWindow,
        maxTokens: meta?.maxTokens,
      });
    }
  }

  // Also include agent primary model if not already listed
  const agentList = agents?.list as Array<Record<string, unknown>> | undefined;
  for (const agent of agentList ?? []) {
    const primaryModel = typeof agent?.model === "string" ? agent.model : undefined;
    if (primaryModel && !seen.has(primaryModel)) {
      const slashIdx = primaryModel.indexOf("/");
      const meta = providerMeta.get(primaryModel);
      entries.push({
        id: primaryModel,
        name: meta?.name ?? (slashIdx > 0 ? primaryModel.slice(slashIdx + 1) : primaryModel),
        provider: slashIdx > 0 ? primaryModel.slice(0, slashIdx) : "",
        reasoning: meta?.reasoning,
        contextWindow: meta?.contextWindow,
        maxTokens: meta?.maxTokens,
      });
    }
  }

  return entries;
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
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return true;
  }

  const models = resolveConfiguredModels();

  const rt = getFridayAgentForwardRuntime();
  const cfg = rt?.getConfig() as Record<string, unknown> | undefined;
  const agents = cfg?.agents as Record<string, unknown> | undefined;
  const agentDefaults = agents?.defaults as Record<string, unknown> | undefined;
  const agentModel = agentDefaults?.model as Record<string, unknown> | undefined;
  const defaultModel = typeof agentModel?.primary === "string" ? agentModel.primary : "";

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, models, defaultModel }));
  return true;
}
