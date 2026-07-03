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
  return transcriptWith(name, "hi");
}

/** Transcript whose first user message carries `userText` (for cron-title parsing). */
function transcriptWith(name: string, userText: string): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: "message", id: "m", message: { role: "user", content: userText } })}\n`,
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

  it("surfaces recent cron sessions with a title parsed from the [cron:…] preamble", async () => {
    const now = Date.now();
    setForward(
      { agents: { list: [{ id: "main" }] } },
      {
        main: {
          // Recent cron with the injected preamble → title = <name> ("今早科技要闻").
          "agent:main:cron:job-1": {
            sessionId: "cr1",
            updatedAt: now - 1000,
            sessionFile: transcriptWith(
              "cr1.jsonl",
              "[cron:job-1 今早科技要闻] 查询今天的科技要闻 Current time: Friday",
            ),
          },
          // Nameless cron → core stamps the placeholder "自动化" → title falls back
          // to the prompt ("写首诗"), so distinct nameless jobs stay distinguishable.
          "agent:main:cron:job-2": {
            sessionId: "cr2",
            updatedAt: now - 2000,
            sessionFile: transcriptWith(
              "cr2.jsonl",
              "[cron:job-2 自动化] 写首诗 Current time: Thursday",
            ),
          },
          // Stale cron (outside the 7-day window) → dropped.
          "agent:main:cron:job-old": {
            sessionId: "cr3",
            updatedAt: now - 30 * 24 * 60 * 60 * 1000,
            sessionFile: transcriptWith("cr3.jsonl", "[cron:job-old 旧任务] 旧提示 Current time: X"),
          },
        },
      },
    );
    const res = new MockRes();
    await handleHistorySessions(makeReq(AUTH), res as any);
    const sessions = JSON.parse(res.body).sessions;
    expect(sessions.map((s: any) => s.sessionKey)).toEqual([
      "agent:main:cron:job-1",
      "agent:main:cron:job-2",
    ]);
    expect(sessions[0].title).toBe("今早科技要闻");
    expect(sessions[1].title).toBe("写首诗"); // placeholder name "自动化" → prompt
  });

  it("collapses many per-run cron sessions of one job into the latest", async () => {
    const now = Date.now();
    setForward(
      { agents: { list: [{ id: "main" }] } },
      {
        main: {
          "agent:main:cron:run-a": {
            sessionId: "a",
            updatedAt: now - 5000,
            sessionFile: transcriptWith("a.jsonl", "[cron:run-a 每日天气简报] 天气 Current time: X"),
          },
          "agent:main:cron:run-b": {
            sessionId: "b",
            updatedAt: now - 1000, // newest run of the SAME job → the one kept
            sessionFile: transcriptWith("b.jsonl", "[cron:run-b 每日天气简报] 天气 Current time: Y"),
          },
          "agent:main:cron:run-c": {
            sessionId: "c",
            updatedAt: now - 2000, // different job → its own pill
            sessionFile: transcriptWith("c.jsonl", "[cron:run-c 股票狙击手] 股票 Current time: Z"),
          },
        },
      },
    );
    const res = new MockRes();
    await handleHistorySessions(makeReq(AUTH), res as any);
    const sessions = JSON.parse(res.body).sessions;
    // Two distinct jobs; the weather job keeps only its newest run (run-b).
    expect(sessions.map((s: any) => s.sessionKey)).toEqual([
      "agent:main:cron:run-b",
      "agent:main:cron:run-c",
    ]);
    expect(sessions.map((s: any) => s.title)).toEqual(["每日天气简报", "股票狙击手"]);
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
