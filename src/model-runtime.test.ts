import { describe, it, expect } from "vitest";
import { resolveModelRuntime } from "./model-runtime.js";

describe("resolveModelRuntime", () => {
  it("reports the embedded runtime for a plain provider model with no policy", () => {
    const cfg = {
      models: {
        providers: {
          deepseek: { baseUrl: "https://api.deepseek.com", models: [{ id: "deepseek-v4-pro" }] },
        },
      },
    };
    expect(resolveModelRuntime({ cfg, provider: "deepseek", modelId: "deepseek-v4-pro" })).toEqual({
      id: "openclaw",
      source: "implicit",
    });
  });

  it("defaults OpenAI on the official endpoint to the Codex harness", () => {
    // No `models.providers.openai` entry at all still counts as the official endpoint.
    expect(resolveModelRuntime({ cfg: {}, provider: "openai", modelId: "gpt-5.6-sol" })).toEqual({
      id: "codex",
      source: "implicit",
    });
    expect(
      resolveModelRuntime({
        cfg: { models: { providers: { openai: { baseUrl: "https://api.openai.com/v1" } } } },
        provider: "openai",
        modelId: "gpt-5.6-sol",
      }),
    ).toEqual({ id: "codex", source: "implicit" });
  });

  it("keeps a custom OpenAI-compatible base URL on the embedded runtime", () => {
    expect(
      resolveModelRuntime({
        cfg: { models: { providers: { openai: { baseUrl: "https://proxy.example.com/v1" } } } },
        provider: "openai",
        modelId: "gpt-5.6-sol",
      }),
    ).toEqual({ id: "openclaw", source: "implicit" });
  });

  it("reads the provider-level runtime policy", () => {
    expect(
      resolveModelRuntime({
        cfg: { models: { providers: { anthropic: { agentRuntime: { id: "claude-cli" } } } } },
        provider: "anthropic",
        modelId: "claude-opus-5",
      }),
    ).toEqual({ id: "claude-cli", source: "provider" });
  });

  it("prefers the catalog model entry over the provider policy", () => {
    const cfg = {
      models: {
        providers: {
          anthropic: {
            agentRuntime: { id: "claude-cli" },
            models: [{ id: "claude-opus-5", agentRuntime: { id: "openclaw" } }],
          },
        },
      },
    };
    expect(resolveModelRuntime({ cfg, provider: "anthropic", modelId: "claude-opus-5" })).toEqual({
      id: "openclaw",
      source: "model",
    });
  });

  it("prefers an exact agents.defaults.models key over the catalog and the provider wildcard", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/*": { agentRuntime: { id: "openclaw" } },
            "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
      models: {
        providers: {
          anthropic: { models: [{ id: "claude-opus-5", agentRuntime: { id: "codex" } }] },
        },
      },
    };
    expect(resolveModelRuntime({ cfg, provider: "anthropic", modelId: "claude-opus-5" })).toEqual({
      id: "claude-cli",
      source: "model",
    });
  });

  it("lets the per-agent models map win over agents.defaults", () => {
    const cfg = {
      agents: {
        list: [{ id: "Research Bot", models: { "deepseek/*": { agentRuntime: { id: "codex" } } } }],
        defaults: { models: { "deepseek/*": { agentRuntime: { id: "openclaw" } } } },
      },
    };
    expect(
      resolveModelRuntime({
        cfg,
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        agentId: "research-bot",
      }),
    ).toEqual({ id: "codex", source: "model" });
    // Without the agent scope only the defaults map applies.
    expect(resolveModelRuntime({ cfg, provider: "deepseek", modelId: "deepseek-v4-pro" })).toEqual({
      id: "openclaw",
      source: "model",
    });
  });

  it("falls back to the provider wildcard when no exact key matches", () => {
    const cfg = {
      agents: { defaults: { models: { "deepseek/*": { agentRuntime: { id: "codex" } } } } },
    };
    expect(resolveModelRuntime({ cfg, provider: "deepseek", modelId: "deepseek-chat" })).toEqual({
      id: "codex",
      source: "model",
    });
  });

  it("normalizes retired runtime aliases and treats auto/default as no policy", () => {
    const pi = { models: { providers: { deepseek: { agentRuntime: { id: "PI" } } } } };
    expect(resolveModelRuntime({ cfg: pi, provider: "deepseek", modelId: "x" })).toEqual({
      id: "openclaw",
      source: "provider",
    });
    const legacyCodex = {
      models: { providers: { deepseek: { agentRuntime: { id: "codex-app-server" } } } },
    };
    expect(resolveModelRuntime({ cfg: legacyCodex, provider: "deepseek", modelId: "x" })).toEqual({
      id: "codex",
      source: "provider",
    });
    for (const id of ["auto", "default"]) {
      const cfg = { models: { providers: { deepseek: { agentRuntime: { id } } } } };
      expect(resolveModelRuntime({ cfg, provider: "deepseek", modelId: "x" })).toEqual({
        id: "openclaw",
        source: "implicit",
      });
    }
  });

  it("accepts a provider-qualified modelId and bare model keys", () => {
    const cfg = {
      agents: { defaults: { models: { "deepseek-chat": { agentRuntime: { id: "codex" } } } } },
    };
    expect(
      resolveModelRuntime({ cfg, provider: undefined, modelId: "deepseek/deepseek-chat" }),
    ).toEqual({
      id: "codex",
      source: "model",
    });
  });

  it("falls back to the embedded runtime when an unqualified model matches several providers", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "a/shared": { agentRuntime: { id: "codex" } },
            "b/shared": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    };
    expect(resolveModelRuntime({ cfg, provider: "", modelId: "shared" })).toEqual({
      id: "openclaw",
      source: "implicit",
    });
  });
});
