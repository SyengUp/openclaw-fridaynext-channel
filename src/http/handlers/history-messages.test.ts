import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleHistoryMessages } from "./history-messages.js";
import { setFridayNextRuntime } from "../../runtime.js";
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

function makeReq(path: string, headers: Record<string, string> = {}, method = "GET"): any {
  return { method, url: path, headers };
}

const AUTH = { authorization: "Bearer test-token" };
const CFG = {
  channels: { "friday-next": { authToken: "test-token", pathPrefix: "/friday-next" } },
  gateway: { auth: { token: "test-token" } },
};

let tmpDir = "";

/** Auth config + optional subagent fallback. */
function setRuntime(getSessionMessages?: (params: { sessionKey: string; limit?: number }) => Promise<{ messages?: unknown[] }>): void {
  setFridayNextRuntime({
    config: { loadConfig: () => CFG },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    ...(getSessionMessages ? { subagent: { getSessionMessages } } : {}),
  } as never);
}

/** Forward runtime: store keyed by full session key → entry with a sessionFile. */
function setForward(store: Record<string, unknown>): void {
  setFridayAgentForwardRuntime({
    runtime: {
      agent: {
        session: {
          resolveStorePath: (_s?: string, opts?: { agentId?: string }) =>
            path.join(tmpDir, `${opts?.agentId ?? "main"}-sessions.json`),
          loadSessionStore: () => store,
        },
      },
      config: { current: () => CFG },
    },
  } as any);
}

function writeTranscript(name: string, lines: unknown[]): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  return file;
}

describe("handleHistoryMessages", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-hist-"));
    setRuntime();
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
    await handleHistoryMessages(makeReq("/friday-next/history/messages", AUTH, "POST"), res as any);
    expect(res.statusCode).toBe(405);
  });

  it("rejects missing token with 401", async () => {
    const res = new MockRes();
    await handleHistoryMessages(makeReq("/friday-next/history/messages"), res as any);
    expect(res.statusCode).toBe(401);
  });

  it("400s when sessionKey is missing", async () => {
    const res = new MockRes();
    await handleHistoryMessages(makeReq("/friday-next/history/messages", AUTH), res as any);
    expect(res.statusCode).toBe(400);
  });

  it("reads the transcript file from disk including user + assistant messages", async () => {
    const file = writeTranscript("sess.jsonl", [
      { type: "session", version: 1, sessionId: "s" },
      { type: "message", id: "u1", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hi there" } },
      { type: "message", id: "a1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "hello" }], model: "openai/gpt-4" } },
    ]);
    setForward({ "agent:main:main": { sessionId: "s", sessionFile: file } });

    const res = new MockRes();
    await handleHistoryMessages(makeReq("/friday-next/history/messages?sessionKey=agent:main:main", AUTH), res as any);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(body.messages[0].text).toBe("hi there");
    expect(body.messages[1].text).toBe("hello");
  });

  it("returns the cumulative sessionUsage snapshot from the store", async () => {
    const file = writeTranscript("usage.jsonl", [
      { type: "message", id: "u1", message: { role: "user", content: "hi" } },
      { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "yo" }], model: "openai/gpt-4" } },
    ]);
    setForward({
      "agent:main:main": {
        sessionId: "s",
        sessionFile: file,
        model: "openai/gpt-4",
        totalTokens: 12_480,
        contextTokens: 128_000,
        inputTokens: 9_000,
        outputTokens: 3_480,
      },
    });

    const res = new MockRes();
    await handleHistoryMessages(makeReq("/friday-next/history/messages?sessionKey=agent:main:main", AUTH), res as any);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessionUsage).toBeDefined();
    expect(body.sessionUsage.modelId).toBe("openai/gpt-4");
    expect(body.sessionUsage.context).toEqual({ windowMax: 128_000, used: 12_480 });
    expect(body.sessionUsage.tokens.total).toBe(12_480);
  });

  it("omits sessionUsage when the store has no entry", async () => {
    const file = writeTranscript("nousage.jsonl", [
      { type: "message", id: "u1", message: { role: "user", content: "hi" } },
    ]);
    setForward({ "agent:main:main": { sessionId: "s", sessionFile: file } });

    const res = new MockRes();
    await handleHistoryMessages(makeReq("/friday-next/history/messages?sessionKey=agent:main:main", AUTH), res as any);
    const body = JSON.parse(res.body);
    expect(body.sessionUsage).toBeUndefined();
  });

  it("resolves the entry case-insensitively (app upper-cases deviceId)", async () => {
    const file = writeTranscript("fd.jsonl", [
      { type: "message", id: "u1", message: { role: "user", content: "from app" } },
    ]);
    // Store keyed lower-case (as sessions.json persists it).
    setForward({ "agent:main:friday:direct:abcd-1234:9": { sessionId: "x", sessionFile: file } });

    const res = new MockRes();
    await handleHistoryMessages(
      makeReq("/friday-next/history/messages?sessionKey=agent:main:friday:direct:ABCD-1234:9", AUTH),
      res as any,
    );
    const body = JSON.parse(res.body);
    expect(body.messages.map((m: any) => m.role)).toEqual(["user"]);
    expect(body.messages[0].text).toBe("from app");
  });

  it("resolves user [media attached: file://] markers into downloadable /friday-next/files URLs", async () => {
    // The server-local source the marker points at (only exists on the gateway host).
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-inbound-"));
    const srcFile = path.join(srcDir, "ce1ff405-28ad-48b9-b4a7-4f2228d77649.jpg");
    fs.writeFileSync(srcFile, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    const file = writeTranscript("media.jsonl", [
      {
        type: "message",
        id: "u1",
        message: {
          role: "user",
          content: `你见过这个可乐吗？\n\n[media attached: file://${srcFile}]`,
        },
      },
    ]);
    setForward({ "agent:main:main": { sessionId: "s", sessionFile: file } });

    const res = new MockRes();
    await handleHistoryMessages(
      makeReq("/friday-next/history/messages?sessionKey=agent:main:main", AUTH),
      res as any,
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const userMsg = body.messages.find((m: any) => m.role === "user");
    expect(userMsg.images?.length).toBe(1);
    // The raw server-local file:// path must be resolved to a gateway-served URL the
    // app can actually download — otherwise the attachment bubble is lost on history sync.
    expect(userMsg.images[0].url.startsWith("file://")).toBe(false);
    expect(userMsg.images[0].url.startsWith("/friday-next/files/")).toBe(true);
    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  it("falls back to getSessionMessages when the transcript is not on disk", async () => {
    setForward({}); // no entry → disk read yields nothing
    setRuntime(async () => ({
      messages: [{ role: "assistant", content: "fallback", __openclaw: { id: "a1", seq: 1 } }],
    }));
    const res = new MockRes();
    await handleHistoryMessages(makeReq("/friday-next/history/messages?sessionKey=agent:main:main", AUTH), res as any);
    const body = JSON.parse(res.body);
    expect(body.messages.map((m: any) => m.id)).toEqual(["a1"]);
  });
});
