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
  const models = cfg?.models as Record<string, unknown> | undefined;
  const providers = models?.providers as Record<string, unknown> | undefined;
  if (!providers) return [];

  const entries: FridayModelEntry[] = [];
  for (const [providerId, provider] of Object.entries(providers)) {
    const providerModels = (provider as { models?: Array<Record<string, unknown>> })?.models;
    if (!Array.isArray(providerModels) || providerModels.length === 0) continue;
    for (const m of providerModels) {
      entries.push({
        id: `${providerId}/${m.id ?? m.name}`,
        name: typeof m.name === "string" ? m.name : undefined,
        provider: providerId,
        reasoning: typeof m.reasoning === "boolean" ? m.reasoning : undefined,
        contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
        maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : undefined,
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
