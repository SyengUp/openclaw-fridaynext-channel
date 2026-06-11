import { describe, it, expect, afterEach } from "vitest";
import {
  resolveModelThinking,
  resolveModelThinkingForRef,
  isThinkingLevelSupportedForRef,
} from "./thinking-levels.js";
import {
  setFridayAgentForwardRuntime,
  resetFridayAgentForwardRuntimeForTest,
} from "./agent-forward-runtime.js";

/** Inject a forward runtime whose `resolveThinkingPolicy` echoes the recorded calls + a fixed reply. */
function setThinkingPolicy(
  impl: (params: { provider?: string | null; model?: string | null }) => {
    levels: Array<{ id: string; label: string }>;
    defaultLevel?: string | null;
  },
): { calls: Array<{ provider?: string | null; model?: string | null }> } {
  const calls: Array<{ provider?: string | null; model?: string | null }> = [];
  setFridayAgentForwardRuntime({
    runtime: {
      agent: {
        session: { resolveStorePath: () => "", loadSessionStore: () => ({}) },
        resolveThinkingPolicy: (params: { provider?: string | null; model?: string | null }) => {
          calls.push(params);
          return impl(params);
        },
      },
      config: { current: () => ({}) },
    },
  } as never);
  return { calls };
}

describe("resolveModelThinking", () => {
  afterEach(() => {
    resetFridayAgentForwardRuntimeForTest();
  });

  it("returns the runtime-resolved levels + default for a model that supports xhigh", () => {
    setThinkingPolicy(() => ({
      levels: [
        { id: "off", label: "off" },
        { id: "minimal", label: "minimal" },
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "high" },
        { id: "xhigh", label: "xhigh" },
      ],
      defaultLevel: "high",
    }));
    const result = resolveModelThinking("openai", "gpt-5.4");
    expect(result.levels.map((l) => l.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(result.default).toBe("high");
  });

  it("passes binary on/off labels through unchanged", () => {
    setThinkingPolicy(() => ({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "on" },
      ],
    }));
    const result = resolveModelThinking("moonshot", "kimi-k2");
    expect(result.levels).toEqual([
      { id: "off", label: "off" },
      { id: "low", label: "on" },
    ]);
    expect(result.default).toBeUndefined();
  });

  it("falls back to the base five levels when no runtime is registered", () => {
    const result = resolveModelThinking("anything", "model-x");
    expect(result.levels.map((l) => l.id)).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(result.default).toBeUndefined();
  });

  it("falls back to the base levels when resolveThinkingPolicy throws", () => {
    setThinkingPolicy(() => {
      throw new Error("boom");
    });
    const result = resolveModelThinking("openai", "gpt-5.4");
    expect(result.levels.map((l) => l.id)).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("falls back to the base levels when the policy returns no levels", () => {
    setThinkingPolicy(() => ({ levels: [] }));
    const result = resolveModelThinking("openai", "gpt-5.4");
    expect(result.levels.map((l) => l.id)).toEqual(["off", "minimal", "low", "medium", "high"]);
  });
});

describe("resolveModelThinkingForRef", () => {
  afterEach(() => {
    resetFridayAgentForwardRuntimeForTest();
  });

  it("splits a provider/model ref and forwards both parts to the policy", () => {
    const { calls } = setThinkingPolicy(() => ({ levels: [{ id: "off", label: "off" }] }));
    resolveModelThinkingForRef("deepseek/deepseek-v4-pro");
    expect(calls).toEqual([{ provider: "deepseek", model: "deepseek-v4-pro" }]);
  });

  it("treats a bare model id as having no provider", () => {
    const { calls } = setThinkingPolicy(() => ({ levels: [{ id: "off", label: "off" }] }));
    resolveModelThinkingForRef("just-a-model");
    expect(calls).toEqual([{ provider: null, model: "just-a-model" }]);
  });

  it("returns the base set for an empty ref without calling the runtime", () => {
    const { calls } = setThinkingPolicy(() => ({ levels: [{ id: "off", label: "off" }] }));
    const result = resolveModelThinkingForRef("");
    expect(calls).toEqual([]);
    expect(result.levels.map((l) => l.id)).toEqual(["off", "minimal", "low", "medium", "high"]);
  });
});

describe("isThinkingLevelSupportedForRef", () => {
  afterEach(() => {
    resetFridayAgentForwardRuntimeForTest();
  });

  it("accepts a level the model supports and rejects one it does not", () => {
    setThinkingPolicy(() => ({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "high" },
        { id: "max", label: "max" },
      ],
    }));
    expect(isThinkingLevelSupportedForRef("deepseek/deepseek-v4", "max")).toBe(true);
    expect(isThinkingLevelSupportedForRef("deepseek/deepseek-v4", "xhigh")).toBe(false);
  });
});
