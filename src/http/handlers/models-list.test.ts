import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { handleModelsList, handleAdminModelsList, mapCoreModelChoice } from "./models-list.js";
import { setMockRuntime } from "../../test-support/mock-runtime.js";
import {
  setFridayAgentForwardRuntime,
  resetFridayAgentForwardRuntimeForTest,
} from "../../agent-forward-runtime.js";

const { dispatchGatewayMethod } = vi.hoisted(() => ({
  dispatchGatewayMethod: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({
  dispatchGatewayMethod,
}));

class MockRes extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  end(body?: string): void {
    if (body) this.body += body;
  }
}

function makeReq(headers: Record<string, string> = {}, method = "GET", query = ""): any {
  return { method, url: `/friday-next/models${query}`, headers };
}

const AUTH = { authorization: "Bearer test-token" };

/** Inject config + an optional per-model thinking-policy resolver into the forward runtime. */
function setRuntime(
  config: unknown,
  resolveThinkingPolicy?: (params: { provider?: string | null; model?: string | null }) => {
    levels: Array<{ id: string; label: string }>;
    defaultLevel?: string | null;
  },
): void {
  setFridayAgentForwardRuntime({
    runtime: {
      agent: {
        session: { resolveStorePath: () => "", loadSessionStore: () => ({}) },
        ...(resolveThinkingPolicy ? { resolveThinkingPolicy } : {}),
      },
      config: { current: () => config },
    },
  } as never);
}

const CONFIG = {
  models: {
    providers: {
      openai: { models: [{ id: "gpt-5.4", name: "GPT-5.4", reasoning: true }] },
    },
  },
  agents: { defaults: { models: { "openai/gpt-5.4": {} }, model: "openai/gpt-5.4" } },
};

describe("handleModelsList thinking levels", () => {
  beforeEach(() => {
    setMockRuntime();
  });

  afterEach(() => {
    resetFridayAgentForwardRuntimeForTest();
  });

  it("attaches the per-model thinking levels + default resolved from the runtime", async () => {
    setRuntime(CONFIG, ({ provider, model }) => {
      expect(provider).toBe("openai");
      expect(model).toBe("gpt-5.4");
      return {
        levels: [
          { id: "off", label: "off" },
          { id: "low", label: "low" },
          { id: "medium", label: "medium" },
          { id: "high", label: "high" },
          { id: "xhigh", label: "xhigh" },
        ],
        defaultLevel: "high",
      };
    });

    const res = new MockRes();
    await handleModelsList(makeReq(AUTH), res as any);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const model = body.models.find((m: any) => m.id === "openai/gpt-5.4");
    expect(model.thinkingLevels.map((l: any) => l.id)).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(model.thinkingDefault).toBe("high");
  });

  it("falls back to the base five levels and omits thinkingDefault on a legacy gateway", async () => {
    setRuntime(CONFIG); // no resolveThinkingPolicy

    const res = new MockRes();
    await handleModelsList(makeReq(AUTH), res as any);

    const body = JSON.parse(res.body);
    const model = body.models.find((m: any) => m.id === "openai/gpt-5.4");
    expect(model.thinkingLevels.map((l: any) => l.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(model.thinkingDefault).toBeUndefined();
  });
});

describe("handleModelsList runtime annotation", () => {
  beforeEach(() => {
    setMockRuntime();
  });

  afterEach(() => {
    resetFridayAgentForwardRuntimeForTest();
  });

  it("reports the executing harness for every model", async () => {
    setRuntime({
      models: {
        providers: {
          deepseek: { baseUrl: "https://api.deepseek.com", models: [{ id: "deepseek-v4-pro" }] },
        },
      },
      agents: {
        defaults: {
          model: "deepseek/deepseek-v4-pro",
          models: { "deepseek/deepseek-v4-pro": {}, "openai/gpt-5.6-sol": {} },
        },
      },
    });

    const res = new MockRes();
    await handleModelsList(makeReq(AUTH), res as any);

    const body = JSON.parse(res.body);
    // OpenAI on the official endpoint runs on Codex; DeepSeek stays on the embedded runtime.
    expect(body.models.find((m: any) => m.id === "openai/gpt-5.6-sol").runtime).toBe("codex");
    expect(body.models.find((m: any) => m.id === "deepseek/deepseek-v4-pro").runtime).toBe(
      "openclaw",
    );
  });

  it("scopes runtime resolution to ?agentId=", async () => {
    setRuntime({
      agents: {
        list: [
          { id: "operator", models: { "deepseek/*": { agentRuntime: { id: "claude-cli" } } } },
        ],
        defaults: { model: "deepseek/deepseek-v4-pro", models: { "deepseek/deepseek-v4-pro": {} } },
      },
    });

    let res = new MockRes();
    await handleModelsList(makeReq(AUTH, "GET", "?agentId=operator"), res as any);
    expect(JSON.parse(res.body).models[0].runtime).toBe("claude-cli");

    // Another agent doesn't inherit operator's override — it stays on the embedded runtime.
    res = new MockRes();
    await handleModelsList(makeReq(AUTH, "GET", "?agentId=main"), res as any);
    expect(JSON.parse(res.body).models[0].runtime).toBe("openclaw");
  });

  it("dedupes agents that share the same primary model", async () => {
    // 2026.8.1+ config shape: `agents.entries` roster with several agents on the same model.
    // Each agent used to emit its own identical row (plus the default) — now a single entry.
    setRuntime({
      agents: {
        defaults: { model: "deepseek/deepseek-v4-pro" },
        entries: {
          "fridaynext-dev": { model: "deepseek/deepseek-v4-pro" },
          operator: { model: "deepseek/deepseek-v4-pro" },
          nana: { model: "deepseek/deepseek-v4-pro" },
          trader: { model: "deepseek/deepseek-v4-pro" },
        },
      },
    });

    const res = new MockRes();
    await handleModelsList(makeReq(AUTH), res as any);

    const body = JSON.parse(res.body);
    expect(body.models).toHaveLength(1);
    expect(body.models[0].id).toBe("deepseek/deepseek-v4-pro");
    expect(body.defaultModel).toBe("deepseek/deepseek-v4-pro");
  });

  it("reads per-agent `models` overrides (entries shape) in addition to primaries", async () => {
    setRuntime({
      agents: {
        defaults: { model: "deepseek/deepseek-v4-pro" },
        entries: {
          main: { models: { "deepseek/deepseek-v4-pro": {}, "deepseek/deepseek-v4-pro-plus": {} } },
        },
      },
    });

    const res = new MockRes();
    await handleModelsList(makeReq(AUTH), res as any);

    const body = JSON.parse(res.body);
    const ids = body.models.map((m: any) => m.id).sort();
    expect(ids).toEqual(["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro-plus"]);
  });

  it("skips wildcard override rows and models without a provider segment", async () => {
    setRuntime({
      agents: {
        defaults: {
          model: "deepseek/deepseek-v4-pro",
          models: { "deepseek/*": { agentRuntime: { id: "openclaw" } } },
        },
        list: [{ id: "operator", model: "deepseek/deepseek-v4-pro" }],
      },
    });

    const res = new MockRes();
    await handleModelsList(makeReq(AUTH), res as any);

    const body = JSON.parse(res.body);
    expect(body.models.map((m: any) => m.id)).toEqual(["deepseek/deepseek-v4-pro"]);
  });
});

describe("mapCoreModelChoice", () => {
  it("qualifies the bare id with its provider (SDK selectionID semantics)", () => {
    const entry = mapCoreModelChoice({
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      provider: "deepseek",
      reasoning: true,
      contextWindow: 128000,
      thinkingLevels: [
        { id: "off", label: "off" },
        { id: "low", label: "low" },
      ],
      thinkingDefault: "low",
      agentRuntime: { id: "codex" },
    });
    expect(entry).toEqual({
      id: "deepseek/deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      provider: "deepseek",
      reasoning: true,
      contextWindow: 128000,
      thinkingLevels: [
        { id: "off", label: "off" },
        { id: "low", label: "low" },
      ],
      thinkingDefault: "low",
      runtime: "codex",
    });
  });

  it("keeps an already-prefixed id and drops missing/blank fields", () => {
    const entry = mapCoreModelChoice({
      id: "openai/gpt-5.6-sol",
      name: "gpt-5.6-sol",
      provider: "openai",
    });
    expect(entry).toEqual({
      id: "openai/gpt-5.6-sol",
      name: "gpt-5.6-sol",
      provider: "openai",
    });
    expect(entry?.thinkingLevels).toBeUndefined();
    expect(entry?.runtime).toBeUndefined();
  });

  it("rejects rows without a provider", () => {
    expect(mapCoreModelChoice({ id: "orphan", name: "orphan", provider: "" })).toBeUndefined();
  });
});

describe("handleAdminModelsList", () => {
  beforeEach(() => {
    setMockRuntime();
    dispatchGatewayMethod.mockReset();
  });

  afterEach(() => {
    resetFridayAgentForwardRuntimeForTest();
  });

  it("adopts the raw models.list result as the list", async () => {
    // New OpenClaw keeps models.list stable, so the picker is the dispatch
    // result itself — including full-catalog rows (gpt-5.6-luna / kimi-k3).
    dispatchGatewayMethod.mockResolvedValue({
      ok: true,
      payload: {
        models: [
          {
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            provider: "deepseek",
            agentRuntime: { id: "openclaw" },
          },
          {
            id: "gpt-5.6-luna",
            name: "gpt-5.6-luna",
            provider: "opencode-go",
            agentRuntime: { id: "codex" },
          },
          {
            id: "kimi-k3",
            name: "kimi-k3",
            provider: "opencode-go",
            agentRuntime: { id: "codex" },
          },
        ],
      },
    });
    setRuntime({
      agents: {
        defaults: { model: "deepseek/deepseek-v4-flash" },
        entries: {
          main: { models: { "deepseek/deepseek-v4-pro": {} } },
        },
      },
    });

    const res = new MockRes();
    await handleAdminModelsList(makeReq({}, "GET", "?agentId=main"), res as any);

    expect(dispatchGatewayMethod).toHaveBeenCalledWith("models.list", { agentId: "main" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.models.map((m: any) => m.id).sort()).toEqual([
      "deepseek/deepseek-v4-flash",
      "opencode-go/gpt-5.6-luna",
      "opencode-go/kimi-k3",
    ]);
    const flash = body.models.find((m: any) => m.id === "deepseek/deepseek-v4-flash");
    expect(flash.runtime).toBe("openclaw");
    // Control UI strategy: the default is the config default, not a list row.
    expect(body.defaultModel).toBe("deepseek/deepseek-v4-flash");
  });

  it("prefers the roster agent primary for defaultModel when ?agentId targets it", async () => {
    dispatchGatewayMethod.mockResolvedValue({
      ok: true,
      payload: {
        models: [
          { id: "deepseek-v4-pro", name: "deepseek-v4-pro", provider: "deepseek" },
          { id: "deepseek-v4-pro-plus", name: "deepseek-v4-pro-plus", provider: "deepseek" },
        ],
      },
    });
    setRuntime({
      agents: {
        defaults: { model: "deepseek/deepseek-v4-pro" },
        list: [{ id: "operator", model: "deepseek/deepseek-v4-pro-plus" }],
      },
    });

    const res = new MockRes();
    await handleAdminModelsList(makeReq({}, "GET", "?agentId=operator"), res as any);

    const body = JSON.parse(res.body);
    expect(body.defaultModel).toBe("deepseek/deepseek-v4-pro-plus");
  });

  it("uses dispatch rows verbatim when the config never names the model with an alias", async () => {
    dispatchGatewayMethod.mockResolvedValue({
      ok: true,
      payload: {
        models: [
          {
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            provider: "deepseek",
            agentRuntime: { id: "openclaw" },
          },
        ],
      },
    });
    // Config only references the model by ref — no alias, no provider catalog row.
    setRuntime({ agents: { defaults: { model: "deepseek/deepseek-v4-flash" } } });

    const res = new MockRes();
    await handleAdminModelsList(makeReq({}, "GET", "?agentId=main"), res as any);

    const body = JSON.parse(res.body);
    const flash = body.models.find((m: any) => m.id === "deepseek/deepseek-v4-flash");
    expect(flash.name).toBe("DeepSeek V4 Flash");
  });

  it("LEGACY-COMPAT falls back to config parsing when dispatch fails", async () => {
    dispatchGatewayMethod.mockRejectedValue(new Error("dispatch reserved for contracts"));
    setRuntime({
      agents: {
        defaults: { model: "deepseek/deepseek-v4-pro" },
        entries: {
          "fridaynext-dev": { model: "deepseek/deepseek-v4-pro" },
          operator: { model: "deepseek/deepseek-v4-pro" },
        },
      },
    });

    const res = new MockRes();
    await handleAdminModelsList(makeReq({}, "GET"), res as any);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.models).toHaveLength(1);
    expect(body.models[0].id).toBe("deepseek/deepseek-v4-pro");
    expect(body.defaultModel).toBe("deepseek/deepseek-v4-pro");
  });

  it("LEGACY-COMPAT falls back when the core returns no models", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { models: [] } });
    setRuntime({ agents: { defaults: { model: "deepseek/deepseek-v4-pro" } } });

    const res = new MockRes();
    await handleAdminModelsList(makeReq({}, "GET"), res as any);

    expect(JSON.parse(res.body).models.map((m: any) => m.id)).toEqual([
      "deepseek/deepseek-v4-pro",
    ]);
  });

  it("returns 405 for non-GET", async () => {
    const res = new MockRes();
    await handleAdminModelsList(makeReq({}, "POST"), res as any);
    expect(res.statusCode).toBe(405);
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });
});
