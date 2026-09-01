import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleAgentsList, parseIdentityNameFromMarkdown } from "./agents-list.js";
import { setMockRuntime } from "../../test-support/mock-runtime.js";
import {
  setFridayAgentForwardRuntime,
  resetFridayAgentForwardRuntimeForTest,
} from "../../agent-forward-runtime.js";
import { setAgentGreetingsBaseDirForTest } from "../../agent-greetings/greetings-store.js";

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
  return { method, url: "/friday-next/agents", headers };
}

const AUTH = { authorization: "Bearer test-token" };

/** Inject a fake config into the forward runtime (handler reads getConfig()). */
function setConfig(config: unknown): void {
  setFridayAgentForwardRuntime({
    runtime: {
      agent: { session: { resolveStorePath: () => "", loadSessionStore: () => ({}) } },
      config: { current: () => config },
    },
  } as any);
}

describe("handleAgentsList", () => {
  // COMPAT(openclaw<2026.8.1): list-shaped fixtures. Rewrite to agents.entries
  // when dropping the list roster; see src/agent-roster.ts.
  let greetingsDir: string;

  beforeEach(() => {
    setMockRuntime();
    // 隔离 greeting store，避免读到测试机上的真实 greetings.json（agent 列表会合并它）。
    greetingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "fn-agents-greetings-"));
    setAgentGreetingsBaseDirForTest(greetingsDir);
  });

  afterEach(() => {
    setAgentGreetingsBaseDirForTest(null);
    fs.rmSync(greetingsDir, { recursive: true, force: true });
    resetFridayAgentForwardRuntimeForTest();
  });

  it("rejects non-GET methods with 405", async () => {
    const res = new MockRes();
    await handleAgentsList(makeReq(AUTH, "POST"), res as any);
    expect(res.statusCode).toBe(405);
  });

  it("rejects missing/invalid bearer token with 401", async () => {
    const res = new MockRes();
    await handleAgentsList(makeReq(), res as any);
    expect(res.statusCode).toBe(401);
  });

  it("returns an implicit main agent when none are configured", async () => {
    setConfig({ agents: { defaults: {} } });
    const res = new MockRes();
    await handleAgentsList(makeReq(AUTH), res as any);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.defaultAgentId).toBe("main");
    expect(body.agents).toEqual([{ id: "main", isDefault: true }]);
  });

  it("maps tools.exec.mode ask → defaultPermissionMode guarded", async () => {
    setConfig({ tools: { exec: { mode: "ask" } } });
    const res = new MockRes();
    await handleAgentsList(makeReq(AUTH), res as any);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).agents).toEqual([
      { id: "main", isDefault: true, defaultPermissionMode: "guarded" },
    ]);
  });

  it("reports the global defaultPermissionMode at top level (no agent override)", async () => {
    setConfig({
      agents: {
        ownership: "explicit",
        defaults: { tools: { exec: { mode: "full" } } },
        entries: {
          main: { name: "F.R.I.D.A.Y" },
          operator: { name: "FridayNext", tools: { exec: { mode: "ask" } } },
        },
      },
    });
    const res = new MockRes();
    await handleAgentsList(makeReq(AUTH), res as any);

    const body = JSON.parse(res.body);
    // Global default is what an inheriting agent runs.
    expect(body.defaultPermissionMode).toBe("full");
    // The agent with its own override still reports its own effective mode.
    const byId = Object.fromEntries(body.agents.map((a: any) => [a.id, a.defaultPermissionMode]));
    expect(byId.main).toBe("full");
    expect(byId.operator).toBe("guarded");
  });

  it("COMPAT(openclaw<2026.8.1): resolves the implicit main name from IDENTITY.md when no agents.list exists", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "friday-identity-main-"));
    fs.writeFileSync(
      path.join(workspace, "IDENTITY.md"),
      "# IDENTITY.md\n\n- **Name:** F.R.I.D.A.Y\n- **Emoji:** 🌿\n",
    );
    try {
      setFridayAgentForwardRuntime({
        runtime: {
          agent: {
            session: { resolveStorePath: () => "", loadSessionStore: () => ({}) },
            resolveAgentWorkspaceDir: () => workspace,
          },
          config: { current: () => ({ agents: { defaults: {} } }) },
        },
      } as any);

      const res = new MockRes();
      await handleAgentsList(makeReq(AUTH), res as any);

      const body = JSON.parse(res.body);
      expect(body.defaultAgentId).toBe("main");
      expect(body.agents).toEqual([{ id: "main", name: "F.R.I.D.A.Y", isDefault: true }]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("lists configured agents with normalized ids and resolved fields", async () => {
    setConfig({
      agents: {
        list: [
          { id: "Main", name: "Primary", model: "openai/gpt-4", thinkingDefault: "medium" },
          {
            id: "Research Bot",
            description: "deep research",
            model: { primary: "anthropic/claude", fallbacks: ["x"] },
            identity: { emoji: "🔬", avatar: "data:..." },
            default: true,
          },
        ],
      },
    });
    const res = new MockRes();
    await handleAgentsList(makeReq(AUTH), res as any);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.defaultAgentId).toBe("research-bot");
    expect(body.agents).toEqual([
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
        avatar: "data:...",
      },
    ]);
  });

  it("inherits agents.defaults.thinkingDefault for agents that don't set their own", async () => {
    setConfig({
      agents: {
        defaults: { thinkingDefault: "medium" },
        list: [
          { id: "main", model: "deepseek/deepseek-v4-flash" }, // no per-agent thinkingDefault
          { id: "worker", model: "deepseek/deepseek-v4-flash", thinkingDefault: "low" },
        ],
      },
    });
    const res = new MockRes();
    await handleAgentsList(makeReq(AUTH), res as any);

    const body = JSON.parse(res.body);
    const byId = Object.fromEntries(body.agents.map((a: any) => [a.id, a.thinkingDefault]));
    // `main` inherits the defaults; `worker`'s explicit value wins over the inherited one.
    expect(byId.main).toBe("medium");
    expect(byId.worker).toBe("low");
  });

  it("inherits agents.defaults.thinkingDefault for the implicit main agent", async () => {
    setConfig({ agents: { defaults: { thinkingDefault: "medium" } } });
    const res = new MockRes();
    await handleAgentsList(makeReq(AUTH), res as any);

    const body = JSON.parse(res.body);
    expect(body.agents).toEqual([{ id: "main", isDefault: true, thinkingDefault: "medium" }]);
  });

  it("falls back to the IDENTITY.md name when config has none", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "friday-identity-"));
    fs.writeFileSync(
      path.join(workspace, "IDENTITY.md"),
      "# IDENTITY.md\n\n- **Name:** 星期五 (Friday)\n- **Emoji:** 🌿\n",
    );
    try {
      setFridayAgentForwardRuntime({
        runtime: {
          agent: {
            session: { resolveStorePath: () => "", loadSessionStore: () => ({}) },
            resolveAgentWorkspaceDir: () => workspace,
          },
          config: { current: () => ({ agents: { list: [{ id: "main" }] } }) },
        },
      } as any);

      const res = new MockRes();
      await handleAgentsList(makeReq(AUTH), res as any);

      const body = JSON.parse(res.body);
      expect(body.agents).toEqual([{ id: "main", name: "星期五 (Friday)", isDefault: true }]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("lists agents.entries on an OpenClaw ≥2026.8.1 roster", async () => {
    setConfig({
      agents: {
        ownership: "explicit",
        defaults: { thinkingDefault: "high" },
        entries: {
          main: { name: "F.R.I.D.A.Y", model: "anthropic/claude" },
          operator: {
            name: "FridayNext",
            description: "ops",
            identity: { emoji: "🛠️" },
          },
        },
      },
    });
    const res = new MockRes();
    await handleAgentsList(makeReq(AUTH), res as any);
    const body = JSON.parse(res.body);
    expect(body.defaultAgentId).toBe("main");
    expect(body.agents.map((a: { id: string }) => a.id)).toEqual(["main", "operator"]);
    expect(body.agents[0]).toMatchObject({
      id: "main",
      name: "F.R.I.D.A.Y",
      model: "anthropic/claude",
      thinkingDefault: "high",
      isDefault: true,
    });
    expect(body.agents[1]).toMatchObject({
      id: "operator",
      name: "FridayNext",
      description: "ops",
      emoji: "🛠️",
      isDefault: false,
      thinkingDefault: "high",
    });
  });

  it("defaults to the first entry when none is marked default and dedups ids", async () => {
    setConfig({
      agents: {
        list: [{ id: "alpha" }, { id: "alpha", name: "dup" }, { id: "beta" }],
      },
    });
    const res = new MockRes();
    await handleAgentsList(makeReq(AUTH), res as any);

    const body = JSON.parse(res.body);
    expect(body.defaultAgentId).toBe("alpha");
    expect(body.agents.map((a: { id: string }) => a.id)).toEqual(["alpha", "beta"]);
    expect(body.agents[0].isDefault).toBe(true);
  });
});

describe("parseIdentityNameFromMarkdown", () => {
  it("extracts the Name value from the OpenClaw template format", () => {
    const md = "# IDENTITY.md\n\n- **Name:** 星期五 (Friday)\n- **Emoji:** 🌿\n";
    expect(parseIdentityNameFromMarkdown(md)).toBe("星期五 (Friday)");
  });

  it("handles a plain unstyled `Name:` line", () => {
    expect(parseIdentityNameFromMarkdown("Name: Jarvis")).toBe("Jarvis");
  });

  it("returns undefined when there is no Name field", () => {
    expect(parseIdentityNameFromMarkdown("- **Emoji:** 🌿\n- **Vibe:** calm")).toBeUndefined();
  });

  it("skips the unfilled template placeholder", () => {
    expect(
      parseIdentityNameFromMarkdown("- **Name:** _(pick something you like)_"),
    ).toBeUndefined();
  });
});
