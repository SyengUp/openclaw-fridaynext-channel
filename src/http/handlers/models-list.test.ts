import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleModelsList } from "./models-list.js";
import { setMockRuntime } from "../../test-support/mock-runtime.js";
import {
  setFridayAgentForwardRuntime,
  resetFridayAgentForwardRuntimeForTest,
} from "../../agent-forward-runtime.js";

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

function makeReq(headers: Record<string, string> = {}, method = "GET"): any {
  return { method, url: "/friday-next/models", headers };
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
