import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  agentIdFromSessionKey,
  toSessionStoreKey,
  setSessionSettings,
  getSessionSettings,
} from "./session-manager.js";

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

  it("writes settings for a non-main agent into agents/<agentId>/sessions", () => {
    seedSessionsFile("operator");
    const sessionKey = "agent:operator:friday:direct:dev:1";

    setSessionSettings(sessionKey, { reasoningLevel: "stream", thinkingLevel: "high" }, historyDir);

    const entry = readEntry("operator", toSessionStoreKey(sessionKey));
    expect(entry?.reasoningLevel).toBe("stream");
    expect(entry?.thinkingLevel).toBe("high");

    // Round-trips through getSessionSettings from the same per-agent file.
    const read = getSessionSettings(sessionKey, historyDir);
    expect(read.reasoningLevel).toBe("stream");
    expect(read.thinkingLevel).toBe("high");
  });

  it("does not leak a non-main agent's settings into the main store", () => {
    seedSessionsFile("operator");
    seedSessionsFile("main");

    setSessionSettings("agent:operator:s1", { modelRef: "openai/gpt-x" }, historyDir);

    expect(readEntry("operator", "agent:operator:s1")?.modelRef).toBe("openai/gpt-x");
    expect(getSessionSettings("main", historyDir).modelRef).toBeUndefined();
  });

  it("still routes bare/main keys to agents/main", () => {
    seedSessionsFile("main");

    setSessionSettings("main", { thinkingLevel: "low" }, historyDir);

    expect(readEntry("main", "agent:main:main")?.thinkingLevel).toBe("low");
  });
});
