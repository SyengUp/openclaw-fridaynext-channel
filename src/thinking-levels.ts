import { getFridayAgentForwardRuntime } from "./agent-forward-runtime.js";
import { splitModelRef } from "./session/session-manager.js";

export interface ThinkingLevelOption {
  id: string;
  label: string;
}

export interface ResolvedModelThinking {
  /** Ordered (off → highest) levels the model supports. */
  levels: ThinkingLevelOption[];
  /** Provider/model default level, when the gateway reports one. */
  default?: string;
}

/**
 * Base five levels used when the running gateway is too old to expose `resolveThinkingPolicy`, or
 * when resolution fails. Mirrors core `BASE_THINKING_LEVELS` (label === id for the base set).
 */
const BASE_THINKING_LEVELS: ThinkingLevelOption[] = [
  { id: "off", label: "off" },
  { id: "minimal", label: "minimal" },
  { id: "low", label: "low" },
  { id: "medium", label: "medium" },
  { id: "high", label: "high" },
];

/**
 * Resolves the thinking-level option set for `provider`/`modelId` from the running gateway's
 * provider plugins + model catalog. The set varies per model (e.g. GPT-5.4 adds `xhigh`, Gemini adds
 * `adaptive`, DeepSeek V4 adds `xhigh`/`max`, binary providers collapse to `off`/`on`). Falls back to
 * the base five levels when the runtime API is unavailable.
 */
export function resolveModelThinking(
  provider: string | undefined | null,
  modelId: string | undefined | null,
): ResolvedModelThinking {
  const resolve = getFridayAgentForwardRuntime()?.resolveThinkingPolicy;
  if (resolve) {
    try {
      const policy = resolve({ provider: provider ?? null, model: modelId ?? null });
      if (policy?.levels?.length) {
        return {
          levels: policy.levels.map((l) => ({ id: l.id, label: l.label })),
          default: policy.defaultLevel ?? undefined,
        };
      }
    } catch {
      // Fall through to the base levels below.
    }
  }
  return { levels: BASE_THINKING_LEVELS };
}

/** Resolves thinking levels for a full `provider/model` ref (or bare model id). */
export function resolveModelThinkingForRef(
  modelRef: string | undefined | null,
): ResolvedModelThinking {
  if (!modelRef) return { levels: BASE_THINKING_LEVELS };
  const split = splitModelRef(modelRef);
  return resolveModelThinking(split.provider, split.modelId);
}

/** Whether `level` is a supported thinking level for the given `provider/model` ref. */
export function isThinkingLevelSupportedForRef(
  modelRef: string | undefined | null,
  level: string,
): boolean {
  return resolveModelThinkingForRef(modelRef).levels.some((l) => l.id === level);
}

/**
 * Clamp `level` to what `modelRef` actually supports, mirroring the app's displayed effective
 * level: keep a supported level, else use the model's own default, else `medium`, else the
 * lowest non-`off` level. Core hard-errors when an explicit per-turn override (which this plugin
 * feeds from the resolved thinking level) is unsupported, so an agent configured `thinkingDefault`
 * the chosen model no longer supports (`high` on a binary off/on provider) would otherwise fail
 * the whole run instead of running at the level the app shows.
 *
 * Unchanged when the gateway reports no per-model policy (legacy fallback is the base five levels,
 * which include the request) so old hosts keep today's behavior.
 */
export function clampThinkingLevelForRef(
  modelRef: string | undefined | null,
  level: string | undefined,
): string | undefined {
  if (!level) return level;
  const { levels, default: modelDefault } = resolveModelThinkingForRef(modelRef);
  if (levels.length === 0 || levels.some((l) => l.id === level)) return level;
  const ids = levels.map((l) => l.id);
  if (modelDefault && ids.includes(modelDefault)) return modelDefault;
  if (ids.includes("medium")) return "medium";
  return ids.find((id) => id !== "off") ?? ids[0];
}
