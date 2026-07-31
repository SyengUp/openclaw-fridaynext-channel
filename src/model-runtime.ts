/**
 * Per-model agent runtime resolution — which harness actually executes a turn for a given model
 * (`codex`, `claude-cli`, …) versus OpenClaw's embedded runtime.
 *
 * Why re-derive it here: the gateway's `models.list` RPC returns `ModelChoice` (id/alias/context/
 * reasoning) with no runtime field, and plugin-sdk exposes no resolver — the only core surface that
 * reports a runtime is `agents.list`, and that is per *agent* (resolved for the agent's default
 * model), not per model. Everything the resolution needs is in the host config, which this plugin
 * already reads for the model/agent catalogs, so we mirror core's precedence
 * (`src/agents/model-runtime-policy.ts` + `harness/policy.ts`), highest first:
 *
 *   1. agents.list[agent].models["<provider>/<model>"].agentRuntime   (exact)
 *   2. agents.defaults.models["<provider>/<model>"].agentRuntime      (exact)
 *   3. models.providers[<provider>].models[].agentRuntime             (exact catalog entry)
 *   4. agents.(list[agent]|defaults).models["<provider>/*"].agentRuntime  (provider wildcard)
 *   5. models.providers[<provider>].agentRuntime
 *
 * A missing / `auto` / `default` policy means the embedded `openclaw` runtime — except OpenAI on the
 * official API endpoint, which core defaults to the Codex harness (`src/agents/openai-routing.ts`).
 * Model keys may be provider-qualified or bare, and `<provider>/*` is a provider-wide wildcard.
 *
 * Every model resolves to *some* runtime, so this never returns "unknown": callers can label the
 * runtime unconditionally, and a missing `runtime` field on the wire means "gateway too old to
 * report it" (not "embedded") — don't paper over that with a default on the client.
 */

import { normalizeAgentId } from "./agent-id.js";

/** Resolved runtime for one model, plus the config surface that supplied it. */
export interface ResolvedModelRuntime {
  /** Canonical runtime id (`codex`, `claude-cli`, `openclaw`, or any registered harness id). */
  id: string;
  source: "model" | "provider" | "implicit";
}

type PolicySource = "model" | "provider";

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeProviderId(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Core's alias normalization (`src/agents/agent-runtime-id.ts`): `pi` is the retired name for the
 * embedded runtime and `codex-app-server` the retired name for the Codex harness.
 */
function normalizeRuntimeId(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return undefined;
  if (raw === "pi") return "openclaw";
  if (raw === "codex-app-server") return "codex";
  return raw;
}

/** `undefined`/`auto`/`default` all mean "let core pick" — no concrete runtime was configured. */
function isDefaultRuntimeId(id: string | undefined): boolean {
  return id === undefined || id === "auto" || id === "default";
}

/** Reads `<record>.agentRuntime.id`, normalized. */
function readRuntimePolicyId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const policy = (value as Record<string, unknown>).agentRuntime;
  if (!policy || typeof policy !== "object") return undefined;
  return normalizeRuntimeId((policy as Record<string, unknown>).id);
}

function splitRef(ref: string): { provider: string; modelId: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = normalizeProviderId(ref.slice(0, slash));
  const modelId = ref.slice(slash + 1).trim();
  return provider && modelId ? { provider, modelId } : undefined;
}

type MatchKind = "exact" | "provider-wildcard";

/**
 * Does a `models` map key (`"<provider>/<model>"`, `"<provider>/*"`, or a bare model id) match the
 * model we're resolving? Mirrors core `modelEntryMatchKind`.
 */
function matchKindForKey(key: string, provider: string, modelId: string): MatchKind | undefined {
  const trimmed = key.trim();
  if (trimmed === modelId) return "exact";
  const parsed = splitRef(trimmed);
  if (!parsed) return undefined;
  // An empty caller provider matches any provider-qualified key (core's `providerMatchesCaller`).
  if (provider && parsed.provider !== provider) return undefined;
  if (parsed.modelId === modelId) return "exact";
  if (parsed.modelId === "*") return "provider-wildcard";
  return undefined;
}

function agentEntryFor(cfg: Record<string, unknown>, agentId: string | undefined) {
  if (!agentId?.trim()) return undefined;
  const normalized = normalizeAgentId(agentId);
  const list = (cfg.agents as Record<string, unknown> | undefined)?.list;
  if (!Array.isArray(list)) return undefined;
  return (list as Array<Record<string, unknown>>).find(
    (entry) => entry && typeof entry === "object" && normalizeAgentId(entry.id) === normalized,
  );
}

/**
 * Scans the agent-scoped then default-scoped `models` maps for a runtime policy at `matchKind`.
 * When the caller's provider is unknown and several providers' keys match, core bails out rather
 * than picking an arbitrary runtime; we do the same (returns `null` = ambiguous).
 */
function scanAgentModelMaps(params: {
  cfg: Record<string, unknown>;
  agentId?: string;
  provider: string;
  modelId: string;
  matchKind: MatchKind;
}): string | undefined | null {
  const agents = params.cfg.agents as Record<string, unknown> | undefined;
  const maps = [
    agentEntryFor(params.cfg, params.agentId)?.models,
    (agents?.defaults as Record<string, unknown> | undefined)?.models,
  ];
  for (const map of maps) {
    if (!map || typeof map !== "object") continue;
    const matches: Array<{ provider: string; runtime: string }> = [];
    for (const [key, entry] of Object.entries(map as Record<string, unknown>)) {
      if (matchKindForKey(key, params.provider, params.modelId) !== params.matchKind) continue;
      const runtime = readRuntimePolicyId(entry);
      if (!runtime) continue;
      matches.push({ provider: splitRef(key)?.provider ?? "", runtime });
    }
    const scoped = params.provider
      ? matches.filter((m) => m.provider === params.provider)
      : matches;
    const candidates = scoped.length > 0 ? scoped : matches;
    const first = candidates[0];
    if (!first) continue;
    if (!params.provider && candidates.some((m) => m.provider !== first.provider)) return null;
    return first.runtime;
  }
  return undefined;
}

function providerConfigFor(
  cfg: Record<string, unknown>,
  provider: string,
): Record<string, unknown> | undefined {
  const providers = (cfg.models as Record<string, unknown> | undefined)?.providers;
  if (!providers || typeof providers !== "object" || !provider) return undefined;
  for (const [key, value] of Object.entries(providers as Record<string, unknown>)) {
    if (normalizeProviderId(key) === provider && value && typeof value === "object") {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

/** Runtime policy on the provider's catalog entry for this exact model. */
function catalogModelRuntime(
  providerConfig: Record<string, unknown> | undefined,
  provider: string,
  modelId: string,
): string | undefined {
  const models = providerConfig?.models;
  if (!Array.isArray(models)) return undefined;
  for (const entry of models as Array<Record<string, unknown>>) {
    const id = readString(entry?.id);
    if (!id) continue;
    if (matchKindForKey(id, provider, modelId) !== "exact") continue;
    const runtime = readRuntimePolicyId(entry);
    if (runtime) return runtime;
  }
  return undefined;
}

/**
 * Core routes OpenAI to the Codex harness by default, but only on the official API endpoint —
 * a custom `baseUrl` keeps the configured (embedded) behaviour. No provider entry at all still
 * counts as official, matching `isOfficialOpenAIBaseUrl(undefined) === true`.
 */
function openAIDefaultsToCodex(
  provider: string,
  providerConfig: Record<string, unknown> | undefined,
): boolean {
  if (provider !== "openai") return false;
  const baseUrl = readString(providerConfig?.baseUrl);
  if (!baseUrl) return true;
  try {
    const url = new URL(baseUrl);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "api.openai.com" &&
      ["", "/", "/v1", "/v1/"].includes(url.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * Resolves the runtime that will execute `provider`/`modelId`. Falls back to the embedded
 * `openclaw` runtime, which is what core runs when nothing is configured — so the result is a
 * complete answer, not "nothing worth showing".
 *
 * `agentId` scopes step 1; omit it to resolve from `agents.defaults` + the model catalog only.
 */
export function resolveModelRuntime(params: {
  cfg: unknown;
  provider: string | undefined;
  modelId: string | undefined;
  agentId?: string;
}): ResolvedModelRuntime {
  const embedded: ResolvedModelRuntime = { id: "openclaw", source: "implicit" };
  const cfg = (params.cfg ?? {}) as Record<string, unknown>;
  const modelId = params.modelId?.trim();
  if (!modelId) return embedded;
  // A bare "provider/model" passed as modelId still carries its provider; prefer the explicit one.
  const provider = normalizeProviderId(params.provider) || splitRef(modelId)?.provider || "";
  const bareModelId = splitRef(modelId)?.modelId ?? modelId;

  let id: string | undefined;
  let source: PolicySource | undefined;

  const exact = scanAgentModelMaps({
    cfg,
    agentId: params.agentId,
    provider,
    modelId: bareModelId,
    matchKind: "exact",
  });
  // Ambiguous across providers — core declines to pick, so report the runtime core would run.
  if (exact === null) return embedded;
  if (exact) {
    id = exact;
    source = "model";
  }

  const providerConfig = providerConfigFor(cfg, provider);

  if (!id) {
    const catalog = catalogModelRuntime(providerConfig, provider, bareModelId);
    if (catalog) {
      id = catalog;
      source = "model";
    }
  }
  if (!id) {
    const wildcard = scanAgentModelMaps({
      cfg,
      agentId: params.agentId,
      provider,
      modelId: bareModelId,
      matchKind: "provider-wildcard",
    });
    if (wildcard) {
      id = wildcard;
      source = "model";
    }
  }
  if (!id) {
    const providerPolicy = readRuntimePolicyId(providerConfig);
    if (providerPolicy) {
      id = providerPolicy;
      source = "provider";
    }
  }

  if (isDefaultRuntimeId(id)) {
    // Nothing configured (or an explicit "auto"): only OpenAI's official endpoint implies a harness,
    // everything else lands on the embedded runtime.
    return openAIDefaultsToCodex(provider, providerConfig)
      ? { id: "codex", source: source ?? "implicit" }
      : embedded;
  }
  return { id: id as string, source: source ?? "implicit" };
}
