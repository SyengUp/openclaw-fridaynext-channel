import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppSimulator } from "../test-support/app-simulator.js";
import {
  createTempHistoryDir,
  removeTempHistoryDir,
  setMockRuntime,
} from "../test-support/mock-runtime.js";
import {
  setFridayAgentForwardRuntime,
  resetFridayAgentForwardRuntimeForTest,
} from "../agent-forward-runtime.js";

/**
 * Inject a fake host config into the forward runtime, which is what
 * agents-list reads via getFridayAgentForwardRuntime().getConfig().
 * setMockRuntime only wires the auth/runtime config, not the forward runtime.
 */
function setForwardConfig(config: unknown): void {
  setFridayAgentForwardRuntime({
    runtime: {
      agent: { session: { resolveStorePath: () => "", loadSessionStore: () => ({}) } },
      config: { current: () => config },
    },
  } as never);
}

async function getAgents(
  app: ReturnType<typeof createAppSimulator>,
  headers?: Record<string, string>,
) {
  const res = await app.rawRequest({ method: "GET", path: "/friday-next/agents", headers });
  return { status: res.status, body: res.body ? JSON.parse(res.body) : {}, headers: res.headers };
}

describe("e2e agents list", () => {
  let historyDir = "";

  beforeEach(() => {
    historyDir = createTempHistoryDir();
  });

  afterEach(() => {
    resetFridayAgentForwardRuntimeForTest();
    removeTempHistoryDir(historyDir);
  });

  it("rejects a bad bearer token with 401", async () => {
    setMockRuntime({ historyDir, authToken: "test-token" });
    setForwardConfig({ agents: { list: [{ id: "main" }] } });
    const app = createAppSimulator({ token: "test-token" });

    const res = await getAgents(app, { authorization: "Bearer wrong-token" });
    expect(res.status).toBe(401);
  });

  it("returns an implicit main agent when none are configured", async () => {
    setMockRuntime({ historyDir, authToken: "test-token" });
    setForwardConfig({ agents: { defaults: {} } });
    const app = createAppSimulator({ token: "test-token" });

    const res = await getAgents(app);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.defaultAgentId).toBe("main");
    expect(res.body.agents).toEqual([{ id: "main", isDefault: true }]);
  });

  it("lists configured agents end-to-end with normalized ids and default selection", async () => {
    setMockRuntime({ historyDir, authToken: "test-token" });
    setForwardConfig({
      agents: {
        list: [
          { id: "Main", name: "Primary", model: "openai/gpt-4", thinkingDefault: "medium" },
          {
            id: "Research Bot",
            description: "deep research",
            model: { primary: "anthropic/claude", fallbacks: ["x"] },
            identity: { emoji: "🔬", avatar: "data:img" },
            default: true,
          },
        ],
      },
    });
    const app = createAppSimulator({ token: "test-token" });

    const res = await getAgents(app);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body.defaultAgentId).toBe("research-bot");
    expect(res.body.agents).toEqual([
      {
        id: "main",
        name: "Primary",
        model: "openai/gpt-4",
        thinkingDefault: "medium",
        isDefault: false,
      },
      {
        id: "research-bot",
        description: "deep research",
        model: "anthropic/claude",
        isDefault: true,
        emoji: "🔬",
        avatar: "data:img",
      },
    ]);
  });
});
