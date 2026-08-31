import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  agentIdFromSessionKey,
  toSessionStoreKey,
  setSessionSettings,
  getSessionSettings,
  resolveDefaultPermissionMode,
} from "./session-manager.js";
import {
  setFridayAgentForwardRuntime,
  resetFridayAgentForwardRuntimeForTest,
} from "../agent-forward-runtime.js";

describe("agentIdFromSessionKey", () => {
  it("extracts the agent id from a fully-qualified key", () => {
    expect(agentIdFromSessionKey("agent:operator:friday:direct:abc:1")).toBe("operator");
    expect(agentIdFromSessionKey("agent:ha-maestro:main")).toBe("ha-maestro");
  });

  it("falls back to main for bare / legacy keys", () => {
    expect(agentIdFromSessionKey("main")).toBe("main");
    expect(agentIdFromSessionKey("friday:direct:dev:1")).toBe("main");
    expect(agentIdFromSessionKey("")).toBe("main");
  });

  it("rejects path-unsafe agent ids (no traversal)", () => {
    expect(agentIdFromSessionKey("agent:../../etc:foo")).toBe("main");
  });
});

describe("per-agent session settings file routing", () => {
  let baseDir: string;
  let historyDir: string;

  // historyDir must contain a `.openclaw` segment so deriveOpenClawBaseDir resolves the base.
  function seedSessionsFile(agentId: string): string {
    const dir = join(baseDir, ".openclaw", "agents", agentId, "sessions");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "sessions.json");
    writeFileSync(file, JSON.stringify({}), "utf-8");
    return file;
  }

  function readEntry(agentId: string, fileKey: string): Record<string, unknown> | undefined {
    const file = join(baseDir, ".openclaw", "agents", agentId, "sessions", "sessions.json");
    const data = JSON.parse(readFileSync(file, "utf-8")) as Record<string, Record<string, unknown>>;
    return data[fileKey];
  }

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "friday-sm-"));
    historyDir = join(baseDir, ".openclaw", "friday-next", "history");
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("writes settings for a non-main agent into agents/<agentId>/sessions", async () => {
    seedSessionsFile("operator");
    const sessionKey = "agent:operator:friday:direct:dev:1";

    await setSessionSettings(sessionKey, { reasoningLevel: "stream", thinkingLevel: "high" }, historyDir);

    const entry = readEntry("operator", toSessionStoreKey(sessionKey));
    expect(entry?.reasoningLevel).toBe("stream");
    expect(entry?.thinkingLevel).toBe("high");

    // Round-trips through getSessionSettings from the same per-agent file.
    const read = getSessionSettings(sessionKey, historyDir);
    expect(read.reasoningLevel).toBe("stream");
    expect(read.thinkingLevel).toBe("high");
  });

  it("does not leak a non-main agent's settings into the main store", async () => {
    seedSessionsFile("operator");
    seedSessionsFile("main");

    await setSessionSettings("agent:operator:s1", { modelRef: "openai/gpt-x" }, historyDir);

    expect(readEntry("operator", "agent:operator:s1")?.modelRef).toBe("openai/gpt-x");
    expect(getSessionSettings("main", historyDir).modelRef).toBeUndefined();
  });

  it("still routes bare/main keys to agents/main", async () => {
    seedSessionsFile("main");

    await setSessionSettings("main", { thinkingLevel: "low" }, historyDir);

    expect(readEntry("main", "agent:main:main")?.thinkingLevel).toBe("low");
  });

  it("clears a stored model override when the trio is set to null (default re-selected)", async () => {
    seedSessionsFile("main");

    // Prior non-default selection.
    await setSessionSettings(
      "main",
      { modelRef: "openai/gpt-x", providerOverride: "openai", modelOverride: "gpt-x" },
      historyDir,
    );
    expect(getSessionSettings("main", historyDir).modelRef).toBe("openai/gpt-x");

    // Switching back to the agent default sends nulls → override is removed, not merged.
    await setSessionSettings(
      "main",
      { modelRef: null, providerOverride: null, modelOverride: null },
      historyDir,
    );

    const entry = readEntry("main", "agent:main:main")!;
    expect(entry.modelRef).toBeUndefined();
    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverride).toBeUndefined();
    expect(getSessionSettings("main", historyDir).modelRef).toBeUndefined();
  });

  it("leaves the stored model override untouched when fields are undefined", async () => {
    seedSessionsFile("main");

    await setSessionSettings(
      "main",
      { modelRef: "openai/gpt-x", providerOverride: "openai", modelOverride: "gpt-x" },
      historyDir,
    );
    // A thinking-only update (model fields undefined) must not disturb the override.
    await setSessionSettings("main", { thinkingLevel: "high" }, historyDir);

    const entry = readEntry("main", "agent:main:main")!;
    expect(entry.thinkingLevel).toBe("high");
    expect(entry.modelRef).toBe("openai/gpt-x");
    expect(entry.providerOverride).toBe("openai");
  });

  it("writes and clears permissionMode in the JSON store", async () => {
    seedSessionsFile("main");

    await setSessionSettings("main", { permissionMode: "guarded" }, historyDir);
    expect(readEntry("main", "agent:main:main")?.permissionMode).toBe("guarded");
    expect(getSessionSettings("main", historyDir).permissionMode).toBe("guarded");

    await setSessionSettings("main", { permissionMode: null }, historyDir);
    expect(readEntry("main", "agent:main:main")?.permissionMode).toBeUndefined();
    expect(getSessionSettings("main", historyDir).permissionMode).toBeUndefined();
  });

  it("leaves stored permissionMode untouched on a thinking-only update", async () => {
    seedSessionsFile("main");

    await setSessionSettings("main", { permissionMode: "full" }, historyDir);
    await setSessionSettings("main", { thinkingLevel: "high" }, historyDir);

    const entry = readEntry("main", "agent:main:main")!;
    expect(entry.thinkingLevel).toBe("high");
    expect(entry.permissionMode).toBe("full");
  });
});

describe("permissionMode canonical store", () => {
  let baseDir: string;
  let historyDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "friday-pm-"));
    historyDir = join(baseDir, ".openclaw", "friday-next", "history");
    const dir = join(baseDir, ".openclaw", "agents", "main", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sessions.json"), JSON.stringify({}), "utf-8");
  });

  afterEach(() => {
    resetFridayAgentForwardRuntimeForTest();
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("prefers getSessionEntry over JSON when the SDK has a row", async () => {
    await setSessionSettings("main", { permissionMode: "guarded" }, historyDir);
    const sdkStore: Record<string, Record<string, unknown>> = {
      "agent:main:main": { permissionMode: "workspace" },
    };
    setFridayAgentForwardRuntime({
      runtime: {
        agent: {
          session: {
            resolveStorePath: () => "/store/main.json",
            loadSessionStore: () => sdkStore,
            getSessionEntry: ({ sessionKey }: { sessionKey: string }) => sdkStore[sessionKey],
          },
        },
        config: { current: () => ({}) },
      },
    } as any);

    expect(getSessionSettings("main", historyDir).permissionMode).toBe("workspace");
  });

  it("treats a SDK row without permissionMode as Default, ignoring JSON residue", async () => {
    await setSessionSettings("main", { permissionMode: "guarded" }, historyDir);
    const sdkStore: Record<string, Record<string, unknown>> = {
      "agent:main:main": { sessionId: "s1" },
    };
    setFridayAgentForwardRuntime({
      runtime: {
        agent: {
          session: {
            resolveStorePath: () => "/store/main.json",
            loadSessionStore: () => sdkStore,
            getSessionEntry: ({ sessionKey }: { sessionKey: string }) => sdkStore[sessionKey],
          },
        },
        config: { current: () => ({}) },
      },
    } as any);

    expect(getSessionSettings("main", historyDir).permissionMode).toBeUndefined();
  });

  it("patches permissionMode via patchSessionEntry", async () => {
    const sdkStore: Record<string, Record<string, unknown>> = {
      "agent:main:main": { sessionId: "s1" },
    };
    const patches: unknown[] = [];
    setFridayAgentForwardRuntime({
      runtime: {
        agent: {
          session: {
            resolveStorePath: () => "/store/main.json",
            loadSessionStore: () => sdkStore,
            getSessionEntry: ({ sessionKey }: { sessionKey: string }) => sdkStore[sessionKey],
            patchSessionEntry: async (params: {
              sessionKey: string;
              update: (entry: Record<string, unknown>) => Record<string, unknown>;
            }) => {
              const patch = await params.update(sdkStore[params.sessionKey] ?? {});
              patches.push(patch);
              Object.assign(sdkStore[params.sessionKey], patch);
              return sdkStore[params.sessionKey];
            },
          },
        },
        config: { current: () => ({}) },
      },
    } as any);

    await setSessionSettings("main", { permissionMode: "read-only" }, historyDir);
    expect(patches).toEqual([{ permissionMode: "read-only" }]);
    expect(getSessionSettings("main", historyDir).permissionMode).toBe("read-only");
  });

  it("patches the store key found by sessionId when the fileKey misses", async () => {
    const realKey = "agent:main:friday:direct:ABCDEF:9";
    const sdkStore: Record<string, Record<string, unknown>> = {
      [realKey]: { sessionId: "mth7v8za" },
    };
    const patchedKeys: string[] = [];
    setFridayAgentForwardRuntime({
      runtime: {
        agent: {
          session: {
            resolveStorePath: () => "/store/main.json",
            loadSessionStore: () => sdkStore,
            getSessionEntry: ({ sessionKey }: { sessionKey: string }) => sdkStore[sessionKey],
            listSessionEntries: () =>
              Object.entries(sdkStore).map(([sessionKey, entry]) => ({ sessionKey, entry })),
            patchSessionEntry: async (params: {
              sessionKey: string;
              update: (entry: Record<string, unknown>) => Record<string, unknown>;
            }) => {
              patchedKeys.push(params.sessionKey);
              const patch = await params.update(sdkStore[params.sessionKey] ?? {});
              Object.assign(sdkStore[params.sessionKey] ?? {}, patch);
              sdkStore[params.sessionKey] = {
                ...(sdkStore[params.sessionKey] ?? {}),
                ...patch,
              };
              return sdkStore[params.sessionKey];
            },
          },
        },
        config: { current: () => ({}) },
      },
    } as any);

    await setSessionSettings("agent:main:mth7v8za", { permissionMode: "guarded" }, historyDir);
    expect(patchedKeys).toEqual([realKey]);
    expect(sdkStore[realKey]?.permissionMode).toBe("guarded");
    expect(getSessionSettings("agent:main:mth7v8za", historyDir).permissionMode).toBe("guarded");
  });

  it("patches agent:main:fridaynext:<id> when looked up by the short id", async () => {
    const realKey = "agent:main:fridaynext:mth7v8za";
    const sdkStore: Record<string, Record<string, unknown>> = {
      [realKey]: { sessionId: "be1480a1-f79c-48a3-8101-e8b312c59b7b" },
    };
    const patchedKeys: string[] = [];
    setFridayAgentForwardRuntime({
      runtime: {
        agent: {
          session: {
            resolveStorePath: () => "/store/main.json",
            loadSessionStore: () => sdkStore,
            getSessionEntry: ({ sessionKey }: { sessionKey: string }) => sdkStore[sessionKey],
            listSessionEntries: () =>
              Object.entries(sdkStore).map(([sessionKey, entry]) => ({ sessionKey, entry })),
            patchSessionEntry: async (params: {
              sessionKey: string;
              update: (entry: Record<string, unknown>) => Record<string, unknown>;
            }) => {
              patchedKeys.push(params.sessionKey);
              const patch = await params.update(sdkStore[params.sessionKey] ?? {});
              sdkStore[params.sessionKey] = { ...(sdkStore[params.sessionKey] ?? {}), ...patch };
              return sdkStore[params.sessionKey];
            },
          },
        },
        config: { current: () => ({}) },
      },
    } as any);

    await setSessionSettings("mth7v8za", { permissionMode: "read-only" }, historyDir);
    expect(patchedKeys).toEqual([realKey]);
    expect(sdkStore[realKey]?.permissionMode).toBe("read-only");
  });

  it("falls back to updateSessionStoreEntry when patchSessionEntry returns null", async () => {
    const fileKey = "agent:main:main";
    const sdkStore: Record<string, Record<string, unknown>> = {
      [fileKey]: { sessionId: "s1" },
    };
    setFridayAgentForwardRuntime({
      runtime: {
        agent: {
          session: {
            resolveStorePath: () => "/store/main.json",
            loadSessionStore: () => sdkStore,
            getSessionEntry: ({ sessionKey }: { sessionKey: string }) => sdkStore[sessionKey],
            patchSessionEntry: async () => null,
            updateSessionStoreEntry: async (params: {
              sessionKey: string;
              update: (entry: Record<string, unknown>) => Record<string, unknown>;
            }) => {
              const patch = await params.update(sdkStore[params.sessionKey] ?? {});
              sdkStore[params.sessionKey] = { ...sdkStore[params.sessionKey], ...patch };
              return sdkStore[params.sessionKey];
            },
          },
        },
        config: { current: () => ({}) },
      },
    } as any);

    await setSessionSettings("main", { permissionMode: "workspace" }, historyDir);
    expect(sdkStore[fileKey]?.permissionMode).toBe("workspace");
  });
});

describe("canonical store model and thinking", () => {
  let baseDir: string;
  let historyDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "friday-model-"));
    historyDir = join(baseDir, ".openclaw", "friday-next", "history");
  });

  afterEach(() => {
    resetFridayAgentForwardRuntimeForTest();
    rmSync(baseDir, { recursive: true, force: true });
  });

  function wireSdk(sdkStore: Record<string, Record<string, unknown>>): unknown[] {
    const patches: unknown[] = [];
    setFridayAgentForwardRuntime({
      runtime: {
        agent: {
          session: {
            resolveStorePath: () => "/store/main.json",
            getSessionEntry: ({ sessionKey }: { sessionKey: string }) => sdkStore[sessionKey],
            listSessionEntries: () =>
              Object.entries(sdkStore).map(([sessionKey, entry]) => ({ sessionKey, entry })),
            patchSessionEntry: async (params: {
              sessionKey: string;
              update: (entry: Record<string, unknown>) => Record<string, unknown>;
            }) => {
              const patch = await params.update(sdkStore[params.sessionKey] ?? {});
              patches.push(patch);
              sdkStore[params.sessionKey] = { ...(sdkStore[params.sessionKey] ?? {}), ...patch };
              for (const [key, value] of Object.entries(patch)) {
                if (value === null) delete sdkStore[params.sessionKey][key];
              }
              return sdkStore[params.sessionKey];
            },
          },
        },
        config: { current: () => ({}) },
      },
    } as any);
    return patches;
  }

  it("patches thinkingLevel via patchSessionEntry when sessions.json is absent", async () => {
    const sdkStore: Record<string, Record<string, unknown>> = {
      "agent:main:fridaynext:abc": { sessionId: "s1" },
    };
    const patches = wireSdk(sdkStore);

    await setSessionSettings(
      "agent:main:fridaynext:abc",
      { thinkingLevel: "high", reasoningLevel: "stream" },
      historyDir,
    );

    expect(patches).toEqual([{ thinkingLevel: "high", reasoningLevel: "stream" }]);
    expect(getSessionSettings("agent:main:fridaynext:abc", historyDir)).toMatchObject({
      thinkingLevel: "high",
      reasoningLevel: "stream",
    });
  });

  it("patches model override with modelOverrideSource=user", async () => {
    const sdkStore: Record<string, Record<string, unknown>> = {
      "agent:main:main": { sessionId: "s1" },
    };
    const patches = wireSdk(sdkStore);

    await setSessionSettings(
      "main",
      { modelRef: "openai/gpt-x", providerOverride: "openai", modelOverride: "gpt-x" },
      historyDir,
    );

    expect(patches).toEqual([
      {
        modelRef: "openai/gpt-x",
        providerOverride: "openai",
        modelOverride: "gpt-x",
        modelOverrideSource: "user",
      },
    ]);
    expect(getSessionSettings("main", historyDir).modelRef).toBe("openai/gpt-x");
  });

  it("clears a model override on the identity row", async () => {
    const sdkStore: Record<string, Record<string, unknown>> = {
      "agent:main:main": {
        sessionId: "s1",
        modelRef: "openai/gpt-x",
        providerOverride: "openai",
        modelOverride: "gpt-x",
        modelOverrideSource: "user",
      },
    };
    wireSdk(sdkStore);

    await setSessionSettings(
      "main",
      { modelRef: null, providerOverride: null, modelOverride: null },
      historyDir,
    );

    expect(sdkStore["agent:main:main"]?.modelOverride).toBeUndefined();
    expect(sdkStore["agent:main:main"]?.modelOverrideSource).toBeUndefined();
    expect(getSessionSettings("main", historyDir).modelRef).toBeUndefined();
  });

  it("prefers SDK thinkingLevel over JSON residue", async () => {
    const dir = join(baseDir, ".openclaw", "agents", "main", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "sessions.json"),
      JSON.stringify({ "agent:main:main": { thinkingLevel: "low" } }),
      "utf-8",
    );
    const sdkStore: Record<string, Record<string, unknown>> = {
      "agent:main:main": { sessionId: "s1", thinkingLevel: "high" },
    };
    wireSdk(sdkStore);

    expect(getSessionSettings("main", historyDir).thinkingLevel).toBe("high");
  });

  it("thinking-only patch does not touch modelOverrideSource", async () => {
    const sdkStore: Record<string, Record<string, unknown>> = {
      "agent:main:main": {
        sessionId: "s1",
        modelOverride: "gpt-x",
        providerOverride: "openai",
        modelOverrideSource: "user",
      },
    };
    const patches = wireSdk(sdkStore);

    await setSessionSettings("main", { thinkingLevel: "medium" }, historyDir);

    expect(patches).toEqual([{ thinkingLevel: "medium" }]);
    expect(sdkStore["agent:main:main"]?.modelOverrideSource).toBe("user");
    expect(sdkStore["agent:main:main"]?.modelOverride).toBe("gpt-x");
  });
});

describe("resolveDefaultPermissionMode", () => {
  it("maps tools.exec.mode ask → guarded", () => {
    expect(resolveDefaultPermissionMode({ tools: { exec: { mode: "ask" } } })).toBe("guarded");
  });

  it("omits allowlist and sandboxed agents", () => {
    expect(resolveDefaultPermissionMode({ tools: { exec: { mode: "allowlist" } } })).toBeUndefined();
    expect(
      resolveDefaultPermissionMode(
        { tools: { exec: { mode: "ask" } } },
        { sandbox: { mode: "all" } },
      ),
    ).toBeUndefined();
  });

  it("prefers per-agent tools.exec.mode", () => {
    expect(
      resolveDefaultPermissionMode(
        { tools: { exec: { mode: "full" } } },
        { tools: { exec: { mode: "deny" } } },
      ),
    ).toBe("read-only");
  });
});
