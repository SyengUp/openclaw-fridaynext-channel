import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleHistorySessions } from "./history-sessions.js";
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
  return { method, url: "/friday-next/history/sessions", headers };
}

const AUTH = { authorization: "Bearer test-token" };

let tmpDir = "";

/** Write a non-empty transcript file and return its absolute path. */
function transcript(name: string): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: "message", id: "m", message: { role: "user", content: "hi" } })}\n`,
    "utf-8",
  );
  return file;
}

function setForward(config: unknown, storesByAgent: Record<string, Record<string, unknown>>): void {
  setFridayAgentForwardRuntime({
    runtime: {
      agent: {
        session: {
          resolveStorePath: (_s?: string, opts?: { agentId?: string }) =>
            path.join(tmpDir, `${opts?.agentId ?? "main"}.json`),
          loadSessionStore: (p: string) => {
            const agentId = path.basename(p, ".json");
            return storesByAgent[agentId] ?? {};
          },
        },
      },
      config: { current: () => config },
    },
  } as any);
}

describe("handleHistorySessions", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-hs-"));
    setMockRuntime();
  });
  afterEach(() => {
    resetFridayAgentForwardRuntimeForTest();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("rejects non-GET with 405", async () => {
    const res = new MockRes();
    await handleHistorySessions(makeReq(AUTH, "POST"), res as any);
    expect(res.statusCode).toBe(405);
  });

  it("rejects missing token with 401", async () => {
    const res = new MockRes();
    await handleHistorySessions(makeReq(), res as any);
    expect(res.statusCode).toBe(401);
  });

  it("lists live sessions with sessionId + server title, sorted by updatedAt", async () => {
    setForward(
      { agents: { list: [{ id: "main" }] } },
      {
        main: {
          "agent:main:main": {
            sessionId: "s-main",
            updatedAt: 100,
            sessionFile: transcript("main.jsonl"),
          },
          "agent:main:friday:direct:dev:1": {
            sessionId: "s-fd",
            updatedAt: 300,
            displayName: "我的会话",
            sessionFile: transcript("fd.jsonl"),
          },
        },
      },
    );
    const res = new MockRes();
    await handleHistorySessions(makeReq(AUTH), res as any);
    const body = JSON.parse(res.body);
    expect(body.sessions.map((s: any) => s.sessionKey)).toEqual([
      "agent:main:friday:direct:dev:1",
      "agent:main:main",
    ]);
    const fd = body.sessions[0];
    expect(fd).toMatchObject({ sessionId: "s-fd", title: "我的会话" });
  });

  it("filters out archived sessions (transcript file missing)", async () => {
    setForward(
      { agents: { list: [{ id: "main" }] } },
      {
        main: {
          "agent:main:live": {
            sessionId: "a",
            updatedAt: 1,
            sessionFile: transcript("live.jsonl"),
          },
          "agent:main:archived": {
            sessionId: "b",
            updatedAt: 2,
            sessionFile: path.join(tmpDir, "gone.jsonl"),
          },
        },
      },
    );
    const res = new MockRes();
    await handleHistorySessions(makeReq(AUTH), res as any);
    const keys = JSON.parse(res.body).sessions.map((s: any) => s.sessionKey);
    expect(keys).toEqual(["agent:main:live"]);
  });

  it("filters out internal/system + subagent sessions", async () => {
    setForward(
      { agents: { list: [{ id: "main" }] } },
      {
        main: {
          "agent:main:main": { sessionId: "ok", updatedAt: 5, sessionFile: transcript("ok.jsonl") },
          "agent:main:main:heartbeat": {
            sessionId: "hb",
            updatedAt: 4,
            sessionFile: transcript("hb.jsonl"),
          },
          "agent:main:cron:abc": {
            sessionId: "c",
            updatedAt: 3,
            sessionFile: transcript("c.jsonl"),
          },
          "agent:main:subagent:xyz": {
            sessionId: "sa",
            updatedAt: 2,
            sessionFile: transcript("sa.jsonl"),
          },
          "agent:main:dreaming-narrative-rem-1": {
            sessionId: "d",
            updatedAt: 1,
            sessionFile: transcript("d.jsonl"),
          },
          "agent:main:child": {
            sessionId: "ch",
            updatedAt: 6,
            spawnedBy: "agent:main:main",
            sessionFile: transcript("ch.jsonl"),
          },
          global: { sessionId: "g", updatedAt: 7, sessionFile: transcript("g.jsonl") },
        },
      },
    );
    const res = new MockRes();
    await handleHistorySessions(makeReq(AUTH), res as any);
    const keys = JSON.parse(res.body).sessions.map((s: any) => s.sessionKey);
    expect(keys).toEqual(["agent:main:main"]);
  });

  it("keeps real conversations that merely carry a parentSessionKey", async () => {
    setForward(
      { agents: { list: [{ id: "main" }] } },
      {
        main: {
          // Webchat session branched off another session: has parentSessionKey
          // but is a genuine user conversation — must be surfaced.
          "agent:main:dashboard:b91ad945": {
            sessionId: "wc",
            updatedAt: 9,
            parentSessionKey: "agent:main:fridaynext:mq5zn7dp",
            sessionFile: transcript("wc.jsonl"),
          },
          // Real subagent fork (spawnedBy) must still be filtered.
          "agent:main:fork": {
            sessionId: "fk",
            updatedAt: 8,
            spawnedBy: "agent:main:main",
            parentSessionKey: "agent:main:main",
            sessionFile: transcript("fk.jsonl"),
          },
        },
      },
    );
    const res = new MockRes();
    await handleHistorySessions(makeReq(AUTH), res as any);
    const keys = JSON.parse(res.body).sessions.map((s: any) => s.sessionKey);
    expect(keys).toEqual(["agent:main:dashboard:b91ad945"]);
  });
});
