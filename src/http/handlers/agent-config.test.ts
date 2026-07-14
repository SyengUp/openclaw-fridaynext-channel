import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleAgentConfig } from "./agent-config.js";
import { setMockRuntime } from "../../test-support/mock-runtime.js";
import {
  setFridayAgentForwardRuntime,
  resetFridayAgentForwardRuntimeForTest,
} from "../../agent-forward-runtime.js";
import { setUpgradeRuntime, resetUpgradeRuntimeForTest } from "../../upgrade-runtime.js";

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

const AUTH = { authorization: "Bearer test-token" };

function makeReq(headers: Record<string, string> = {}, method = "GET", body?: unknown): any {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(stream, { method, url: "/friday-next/agents/main/config", headers });
}

/** Wire both runtimes around a single mutable `config`; mutateConfigFile edits it in place. */
function setRuntimes(config: Record<string, unknown>, workspace?: string): void {
  setFridayAgentForwardRuntime({
    runtime: {
      agent: {
        session: { resolveStorePath: () => "", loadSessionStore: () => ({}) },
        ...(workspace ? { resolveAgentWorkspaceDir: () => workspace } : {}),
      },
      config: { current: () => config },
    },
  } as any);
  setUpgradeRuntime({
    runtime: {
      system: {},
      config: {
        current: () => config,
        mutateConfigFile: async ({ mutate }: { mutate: (draft: unknown) => unknown | void }) => {
          mutate(config);
          return config;
        },
      },
    },
    source: "/dev/path",
  } as any);
}

describe("handleAgentConfig", () => {
  // Skill discovery scans the personal `~/.agents/skills` dir (an "extra" source),
  // so real skills on the dev machine leak into availableSkills assertions unless
  // HOME points at an isolated temp dir (os.homedir() honors $HOME on POSIX).
  let savedHome: string | undefined;
  let isolatedHome = "";

  beforeEach(() => {
    setMockRuntime();
    savedHome = process.env.HOME;
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-home-"));
    process.env.HOME = isolatedHome;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(isolatedHome, { recursive: true, force: true });
    resetFridayAgentForwardRuntimeForTest();
    resetUpgradeRuntimeForTest();
  });

  it("rejects unsupported methods with 405", async () => {
    setRuntimes({});
    const res = new MockRes();
    await handleAgentConfig(makeReq(AUTH, "POST"), res as any, "main");
    expect(res.statusCode).toBe(405);
  });

  it("rejects missing token with 401", async () => {
    setRuntimes({});
    const res = new MockRes();
    await handleAgentConfig(makeReq({}, "GET"), res as any, "main");
    expect(res.statusCode).toBe(401);
  });

  it("GET returns the configured agent's editable fields", async () => {
    setRuntimes({
      agents: {
        list: [
          {
            id: "Research Bot",
            model: { primary: "anthropic/claude", fallbacks: ["openai/gpt-4"] },
            thinkingDefault: "high",
            tools: { profile: "default", deny: ["bash"], allow: ["read", "edit"] },
            skills: ["deep-research", "verify"],
          },
        ],
      },
    });
    const res = new MockRes();
    await handleAgentConfig(makeReq(AUTH), res as any, "research-bot");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.exists).toBe(true);
    expect(body.model).toEqual({ primary: "anthropic/claude", fallbacks: ["openai/gpt-4"] });
    expect(body.thinkingDefault).toBe("high");
    expect(body.tools).toEqual({ profile: "default", allow: ["read", "edit"], deny: ["bash"] });
    expect(body.skills).toEqual(["deep-research", "verify"]);
  });

  it("GET reports exists:false and inherited (undefined) fields for an implicit agent", async () => {
    setRuntimes({ agents: { defaults: {} } });
    const res = new MockRes();
    await handleAgentConfig(makeReq(AUTH), res as any, "main");
    const body = JSON.parse(res.body);
    expect(body.exists).toBe(false);
    expect(body.model).toBeUndefined();
    expect(body.skills).toBeUndefined();
    expect(body.availableSkills).toEqual([]);
  });

  it("GET distinguishes [] (all skills disabled) from absent (inherit)", async () => {
    setRuntimes({ agents: { list: [{ id: "main", skills: [] }] } });
    const res = new MockRes();
    await handleAgentConfig(makeReq(AUTH), res as any, "main");
    expect(JSON.parse(res.body).skills).toEqual([]);
  });

  it("PUT sets the model on an existing entry", async () => {
    const config: Record<string, unknown> = {
      agents: { list: [{ id: "main", model: "old/model" }] },
    };
    setRuntimes(config);
    const res = new MockRes();
    await handleAgentConfig(makeReq(AUTH, "PUT", { model: "openai/gpt-5" }), res as any, "main");
    expect(res.statusCode).toBe(200);
    const entry = (config.agents as any).list[0];
    expect(entry.model).toBe("openai/gpt-5");
  });

  it("PUT model:null deletes the field so it inherits defaults", async () => {
    const config: Record<string, unknown> = {
      agents: { list: [{ id: "main", model: "old/model" }] },
    };
    setRuntimes(config);
    const res = new MockRes();
    await handleAgentConfig(makeReq(AUTH, "PUT", { model: null }), res as any, "main");
    expect(res.statusCode).toBe(200);
    expect("model" in (config.agents as any).list[0]).toBe(false);
  });

  it("PUT skills:[] disables all; skills:null clears the field", async () => {
    const config: Record<string, unknown> = { agents: { list: [{ id: "main", skills: ["a"] }] } };
    setRuntimes(config);

    let res = new MockRes();
    await handleAgentConfig(makeReq(AUTH, "PUT", { skills: [] }), res as any, "main");
    expect((config.agents as any).list[0].skills).toEqual([]);

    res = new MockRes();
    await handleAgentConfig(makeReq(AUTH, "PUT", { skills: null }), res as any, "main");
    expect("skills" in (config.agents as any).list[0]).toBe(false);
  });

  it("PUT creates a bare list entry for an implicit agent, never marking it default", async () => {
    const config: Record<string, unknown> = { agents: { defaults: {} } };
    setRuntimes(config);
    const res = new MockRes();
    await handleAgentConfig(
      makeReq(AUTH, "PUT", { tools: { profile: "restricted" } }),
      res as any,
      "main",
    );
    expect(res.statusCode).toBe(200);
    const list = (config.agents as any).list;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("main");
    expect(list[0].tools).toEqual({ profile: "restricted" });
    expect("default" in list[0]).toBe(false);
  });

  it("PUT rejects a body with no editable fields", async () => {
    setRuntimes({ agents: { list: [{ id: "main" }] } });
    const res = new MockRes();
    await handleAgentConfig(makeReq(AUTH, "PUT", { unrelated: 1 }), res as any, "main");
    expect(res.statusCode).toBe(400);
  });

  it("PUT rejects a non-array, non-null skills value", async () => {
    setRuntimes({ agents: { list: [{ id: "main" }] } });
    const res = new MockRes();
    await handleAgentConfig(makeReq(AUTH, "PUT", { skills: "deep-research" }), res as any, "main");
    expect(res.statusCode).toBe(400);
  });

  it("GET lists skills discovered in the workspace skills/ dir (SKILL.md dirs only)", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "friday-skills-"));
    for (const id of ["deep-research", "verify"]) {
      fs.mkdirSync(path.join(workspace, "skills", id), { recursive: true });
      fs.writeFileSync(path.join(workspace, "skills", id, "SKILL.md"), "# " + id);
    }
    // No SKILL.md → not a skill; must be ignored.
    fs.mkdirSync(path.join(workspace, "skills", "not-a-skill"), { recursive: true });
    try {
      setRuntimes({ agents: { list: [{ id: "main" }] } }, workspace);
      const res = new MockRes();
      await handleAgentConfig(makeReq(AUTH), res as any, "main");
      expect(JSON.parse(res.body).availableSkills.map((s: { id: string }) => s.id)).toEqual([
        "deep-research",
        "verify",
      ]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
