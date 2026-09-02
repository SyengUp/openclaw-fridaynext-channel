import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { getFridayAgentForwardRuntime } from "../../agent-forward-runtime.js";
import { normalizeAgentId } from "../../agent-id.js";
import { listAgentRoster } from "../../agent-roster.js";
import { resolveModelRuntime } from "../../model-runtime.js";
import { splitModelRef } from "../../session/session-manager.js";
import { resolveModelThinking, type ThinkingLevelOption } from "../../thinking-levels.js";
import { isPublicRequest } from "../middleware/public-surface.js";
import { verifySession } from "../../attest/attest-store.js";
import { attestGateDecision, ATTEST_REJECTION_BODY } from "../../attest/attest-gate.js";
import { resolveFridayNextConfig } from "../../config.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { getFridayNextRuntime } from "../../runtime.js";
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
  /**
   * Harness that executes this model: `openclaw` (the embedded runtime) or a registered harness id
   * such as `codex` / `claude-cli`. Always set — an absent field means the gateway predates this
   * field, which clients must not read as "embedded".
   */
  runtime?: string;
}

interface ResolvedModels {
  models: FridayModelEntry[];
  defaultModel: string;
}

/** Extract a primary model ref from the `model` field (string or {primary,...}). */
function resolvePrimaryModel(model: unknown): string | undefined {
  if (typeof model === "string") return readString(model);
  if (model && typeof model === "object") {
    return readString((model as Record<string, unknown>).primary);
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Collects one configured model ref. New OpenClaw configs also carry wildcard keys
 * (`deepseek/*`) inside `agents.*.models`; those are runtime override rows, not
 * concrete picker entries, so they are skipped exactly like core
 * `resolveConfiguredModelEntries` skips them.
 */
function addConfiguredModelEntry(
  modelKey: string,
  alias: unknown,
  providerMeta: Map<string, { name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number }>,
  seen: Set<string>,
  entries: FridayModelEntry[],
): void {
  const key = modelKey.trim();
  if (!key || key.endsWith("/*")) return;
  if (seen.has(key)) return;
  const split = splitModelRef(key);
  if (!split.provider) return;
  seen.add(key);
  const meta = providerMeta.get(key);
  entries.push({
    id: key,
    name: typeof alias === "string" && alias.trim() ? alias.trim() : (meta?.name ?? split.modelId),
    provider: split.provider,
    reasoning: meta?.reasoning,
    contextWindow: meta?.contextWindow,
    maxTokens: meta?.maxTokens,
  });
}

function resolveConfiguredModels(agentId?: string): ResolvedModels {
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
      addConfiguredModelEntry(modelKey, (info as Record<string, unknown> | undefined)?.alias, providerMeta, seen, entries);
    }
  }

  // Roster agents contribute their `model` AND their per-agent `models` map (the
  // latter is where an agent declares model options beyond its primary, e.g.
  // `main.models["provider/model-pro"]`). Both are deduped against what the
  // defaults already listed — duplicate agent primaries must not repeat.
  for (const { config: agent } of listAgentRoster(cfg)) {
    const primaryModel = resolvePrimaryModel(agent?.model);
    if (primaryModel) {
      addConfiguredModelEntry(primaryModel, undefined, providerMeta, seen, entries);
    }
    const perAgentModels = agent?.models as Record<string, Record<string, unknown>> | undefined;
    if (perAgentModels) {
      for (const [modelKey, info] of Object.entries(perAgentModels)) {
        addConfiguredModelEntry(modelKey, (info as Record<string, unknown> | undefined)?.alias, providerMeta, seen, entries);
      }
    }
  }

  // `models.providers.<id>.models[]` are concrete catalog rows (e.g. llama-cpp's
  // local models). Core's configured view surfaces them too; without this the
  // deterministic list would drop them and flip vs the dispatch result.
  const modelsCfg = cfg?.models as Record<string, unknown> | undefined;
  const providers = modelsCfg?.providers as Record<string, unknown> | undefined;
  if (providers) {
    for (const [providerId, provider] of Object.entries(providers)) {
      const providerModels = (provider as { models?: Array<Record<string, unknown>> })?.models;
      if (!Array.isArray(providerModels)) continue;
      for (const m of providerModels) {
        const modelId = typeof m.id === "string" ? m.id : typeof m.name === "string" ? m.name : "";
        if (!modelId || !providerId) continue;
        addConfiguredModelEntry(
          `${providerId}/${modelId}`,
          m.name,
          providerMeta,
          seen,
          entries,
        );
      }
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
    const provider = entry.provider || split.provider;
    const thinking = resolveModelThinking(provider, split.modelId);
    entry.thinkingLevels = thinking.levels;
    if (thinking.default) entry.thinkingDefault = thinking.default;
    entry.runtime = resolveModelRuntime({ cfg, provider, modelId: split.modelId, agentId }).id;
  }

  return { models: entries, defaultModel };
}

function buildProviderModelMeta(cfg: Record<string, unknown>): Map<
  string,
  {
    name?: string;
    reasoning?: boolean;
    contextWindow?: number;
    maxTokens?: number;
  }
> {
  const meta = new Map<
    string,
    { name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number }
  >();
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

// MARK: - Canonical `models.list` (Control UI parity)

/**
 * A model row from the canonical gateway `models.list` method (the same source
 * Control UI's chat model picker reads). Field names follow the gateway protocol.
 */
interface CoreModelChoice {
  id: string;
  name: string;
  provider: string;
  reasoning?: boolean;
  contextWindow?: number;
  thinkingLevels?: Array<{ id: string; label: string }>;
  thinkingDefault?: string;
  agentRuntime?: { id: string };
}

/**
 * Maps a canonical `models.list` choice to the app's `FridayModelEntry`. The app
 * keys models by a provider-qualified ref (`provider/model`), so the bare core
 * `id` is prefixed with `provider` unless it already carries it (mirrors the SDK's
 * `OpenClawChatModelChoice.selectionID`).
 */
export function mapCoreModelChoice(choice: CoreModelChoice): FridayModelEntry | undefined {
  if (!choice || typeof choice !== "object") return undefined;
  const id = typeof choice.id === "string" ? choice.id.trim() : "";
  const provider = typeof choice.provider === "string" ? choice.provider.trim() : "";
  if (!id || !provider) return undefined;
  const ref = id.startsWith(`${provider}/`) ? id : `${provider}/${id}`;
  const name = typeof choice.name === "string" ? choice.name.trim() : "";
  const entry: FridayModelEntry = {
    id: ref,
    provider,
    ...(name ? { name: name === id ? undefined : name } : {}),
    ...(typeof choice.reasoning === "boolean" ? { reasoning: choice.reasoning } : {}),
    ...(typeof choice.contextWindow === "number" ? { contextWindow: choice.contextWindow } : {}),
  };
  if (Array.isArray(choice.thinkingLevels) && choice.thinkingLevels.length > 0) {
    const levels = choice.thinkingLevels
      .map((level) => ({
        id: typeof level?.id === "string" ? level.id.trim() : "",
        label: typeof level?.label === "string" ? level.label.trim() : "",
      }))
      .filter((level) => level.id && level.label);
    if (levels.length > 0) entry.thinkingLevels = levels;
  }
  const thinkingDefault = typeof choice.thinkingDefault === "string" ? choice.thinkingDefault.trim() : "";
  if (thinkingDefault) entry.thinkingDefault = thinkingDefault;
  const runtime = choice.agentRuntime && typeof choice.agentRuntime.id === "string" ? choice.agentRuntime.id.trim() : "";
  if (runtime) entry.runtime = runtime;
  return entry;
}

function dedupeModels(models: FridayModelEntry[]): FridayModelEntry[] {
  const seen = new Set<string>();
  const out: FridayModelEntry[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

/**
 * Fetches the canonical model catalog via the gateway's `models.list` method —
 * the same call Control UI's chat page makes — and maps it to the app shape.
 * Returns undefined when the method is unavailable (old core / plugin-authed
 * scope) or fails, so callers fall back to config parsing.
 */
export async function fetchCoreModelsList(agentId?: string): Promise<FridayModelEntry[] | undefined> {
  let response;
  try {
    response = await dispatchGatewayMethod("models.list", agentId ? { agentId } : {});
  } catch {
    return undefined;
  }
  if (!response?.ok) return undefined;
  const payload = (response.payload ?? {}) as { models?: unknown };
  if (!Array.isArray(payload.models) || payload.models.length === 0) return undefined;
  const mapped = payload.models
    .map((raw) => mapCoreModelChoice(raw as CoreModelChoice))
    .filter((entry): entry is FridayModelEntry => entry !== undefined);
  if (mapped.length === 0) return undefined;
  return dedupeModels(mapped);
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): true {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
  return true;
}

/**
 * `GET /friday-next-admin/models` — gateway-authed sibling of `/friday-next/models`.
 *
 * Returns a DETERMINISTIC picker list: the union of every configured model ref
 * (`agents.defaults.model`, `agents.defaults.models`, every roster agent's
 * `model` + per-agent `models`, and `models.providers.*.models`), enriched with
 * per-model runtime / thinking metadata from core's `models.list` when it can be
 * dispatched.
 *
 * WHY NOT USE THE RAW `models.list` AS THE LIST: core's browse result is NOT
 * stable — once any full-catalog browse warms the prepared-catalog cache it
 * returns the whole provider catalog (e.g. all opencode-go models), and a
 * gateway restart or catalog timeout drops it back to the configured-only set.
 * The picker must not flip between runs, so the list is config-derived and the
 * dispatch only supplies metadata for refs we already show.
 *
 * WHY THE ADMIN PREFIX: `/friday-next` is registered `auth: "plugin"`, and core
 * gives plugin-authed routes a runtime client with an EMPTY operator scope list,
 * so dispatching any scoped method from there is refused. A gateway-authed route
 * cannot overlap that prefix, so it lives next door. `models.list` needs
 * `operator.read`, which the default surface's `operator.write` satisfies.
 */
export async function handleAdminModelsList(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Method Not Allowed" });
  }

  // App Attest gate, mirroring `/friday-next-admin/commands`: this route lives under a
  // SIBLING prefix so the shared `/friday-next/*` gate never sees it, yet the filter proxy
  // exposes it publicly. Gate PUBLIC-marked requests only (the marker is a header — check it
  // before touching the runtime, so LAN requests never need a configured runtime at all).
  if (isPublicRequest(req)) {
    const attestCfg = resolveFridayNextConfig(
      getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
    );
    const gate = attestGateDecision({
      pathname: "/friday-next-admin/models",
      headers: req.headers,
      isPublic: true,
      required: attestCfg.appAttest.required,
      scope: "plugin",
      verify: (t) => verifySession(t, Date.now()),
    });
    if (gate === "reject") return sendJson(res, 403, { ...ATTEST_REJECTION_BODY });
  }

  const rawAgentId = new URL(req.url ?? "", "http://localhost").searchParams.get("agentId");
  const agentId = rawAgentId?.trim() ? normalizeAgentId(rawAgentId) : undefined;

  const { models, defaultModel } = resolveConfiguredModels(agentId);
  const coreModels = await fetchCoreModelsList(agentId);
  if (coreModels) {
    enrichFromCoreModels(models, coreModels);
  }
  return sendJson(res, 200, { ok: true, models, defaultModel });
}

/**
 * Merges metadata from core's `models.list` into the deterministic config-derived
 * list. Only refs already present are touched — dispatch-only rows (the cache-
 * dependent full catalog) are ignored so the list never flips with core's cache.
 */
function enrichFromCoreModels(
  entries: FridayModelEntry[],
  coreModels: FridayModelEntry[],
): void {
  const byRef = new Map(coreModels.map((m) => [m.id, m]));
  for (const entry of entries) {
    const core = byRef.get(entry.id);
    if (!core) continue;
    if (core.runtime) entry.runtime = core.runtime;
    if (core.thinkingLevels && core.thinkingLevels.length > 0) {
      entry.thinkingLevels = core.thinkingLevels;
    }
    if (core.thinkingDefault) entry.thinkingDefault = core.thinkingDefault;
    if (core.reasoning !== undefined) entry.reasoning = core.reasoning;
    if (core.contextWindow !== undefined) entry.contextWindow = core.contextWindow;
    if (core.maxTokens !== undefined) entry.maxTokens = core.maxTokens;
  }
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

  // `?agentId=` scopes per-model runtime resolution to that agent's `models` overrides; without it
  // resolution falls back to `agents.defaults` + the model catalog.
  const rawAgentId = new URL(req.url ?? "", "http://localhost").searchParams.get("agentId");
  const agentId = rawAgentId?.trim() ? normalizeAgentId(rawAgentId) : undefined;
  const { models, defaultModel } = resolveConfiguredModels(agentId);

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, models, defaultModel }));
  return true;
}