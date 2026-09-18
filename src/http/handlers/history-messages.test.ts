import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleHistoryMessages, handleHistoryMessageDetail, serverLocalPathForImageUrl } from "./history-messages.js";
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
function setRuntime(
  getSessionMessages?: (params: {
    sessionKey: string;
    limit?: number;
  }) => Promise<{ messages?: unknown[] }>,
): void {
  setFridayNextRuntime({
    config: { loadConfig: () => CFG },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    ...(getSessionMessages ? { subagent: { getSessionMessages } } : {}),
  } as never);
}

/** Forward runtime: store keyed by full session key → entry with a sessionFile. */
function setForward(
  store: Record<string, unknown>,
  extra?: {
    getSessionEntry?: boolean;
    loadTranscriptEventsSync?: (params: { sessionId: string; sessionKey?: string }) => unknown[];
    gatewayRequest?: ReturnType<typeof vi.fn>;
  },
): void {
  setFridayAgentForwardRuntime({
    runtime: {
      ...(extra?.gatewayRequest
        ? {
            gateway: {
              isAvailable: async () => true,
              request: extra.gatewayRequest,
            },
          }
        : {}),
      agent: {
        session: {
          resolveStorePath: (_s?: string, opts?: { agentId?: string }) =>
            path.join(tmpDir, `${opts?.agentId ?? "main"}-sessions.json`),
          loadSessionStore: () => store,
          ...(extra?.getSessionEntry
            ? {
                getSessionEntry: ({ sessionKey }: { sessionKey: string }) =>
                  (store[sessionKey] as Record<string, unknown> | undefined) ?? undefined,
              }
            : {}),
          ...(extra?.loadTranscriptEventsSync
            ? { loadTranscriptEventsSync: extra.loadTranscriptEventsSync }
            : {}),
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
      {
        type: "message",
        id: "u1",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "hi there" },
      },
      {
        type: "message",
        id: "a1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          model: "openai/gpt-4",
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
    expect(body.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(body.messages[0].text).toBe("hi there");
    expect(body.messages[1].text).toBe("hello");
  });

  it("falls back to a current-context snapshot from the store on older hosts", async () => {
    const file = writeTranscript("usage.jsonl", [
      { type: "message", id: "u1", message: { role: "user", content: "hi" } },
      {
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "yo" }],
          model: "openai/gpt-4",
        },
      },
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
    await handleHistoryMessages(
      makeReq("/friday-next/history/messages?sessionKey=agent:main:main", AUTH),
      res as any,
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessionUsage).toBeDefined();
    expect(body.sessionUsage.modelId).toBe("openai/gpt-4");
    expect(body.sessionUsage.context).toEqual({ windowMax: 128_000, used: 12_480 });
    expect(body.sessionUsage.tokens.total).toBe(12_480);
  });

  it("uses the Control UI sessions.list row for the current context snapshot", async () => {
    const file = writeTranscript("control-ui-usage.jsonl", [
      { type: "message", id: "u1", message: { role: "user", content: "hi" } },
      {
        type: "message",
        id: "a1",
        message: { role: "assistant", content: [{ type: "text", text: "yo" }] },
      },
    ]);
    const gatewayRequest = vi.fn(async () => ({
      sessions: [
        {
          key: "agent:main:main",
          model: "kimi-for-coding",
          modelProvider: "kimi",
          inputTokens: 1_092,
          outputTokens: 453,
          cacheRead: 18_688,
          totalTokens: 19_780,
          totalTokensFresh: true,
          contextTokens: 262_144,
        },
      ],
    }));
    setForward(
      {
        "agent:main:main": {
          sessionId: "s",
          sessionFile: file,
          totalTokens: 99_999,
          totalTokensFresh: true,
          contextTokens: 128_000,
        },
      },
      { gatewayRequest },
    );

    const res = new MockRes();
    await handleHistoryMessages(
      makeReq("/friday-next/history/messages?sessionKey=agent:main:main", AUTH),
      res as any,
    );

    const body = JSON.parse(res.body);
    expect(body.sessionUsage.context).toEqual({ windowMax: 262_144, used: 19_780 });
    expect(body.sessionUsage.tokens.total).toBe(19_780);
    expect(body.sessionUsage.tokens.totalFresh).toBe(true);
    expect(gatewayRequest).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({
        agentId: "main",
        search: "agent:main:main",
      }),
      expect.objectContaining({ scopes: ["operator.read"] }),
    );
  });

  it("does not resurrect a raw-store token value omitted by sessions.list", async () => {
    const file = writeTranscript("projected-usage-missing.jsonl", [
      { type: "message", id: "u1", message: { role: "user", content: "hi" } },
    ]);
    const gatewayRequest = vi.fn(async () => ({ sessions: [] }));
    setForward(
      {
        "agent:main:main": {
          sessionId: "s",
          sessionFile: file,
          totalTokens: 99_999,
          totalTokensFresh: false,
          contextTokens: 128_000,
        },
      },
      { gatewayRequest },
    );

    const res = new MockRes();
    await handleHistoryMessages(
      makeReq("/friday-next/history/messages?sessionKey=agent:main:main", AUTH),
      res as any,
    );

    expect(JSON.parse(res.body).sessionUsage).toBeUndefined();
  });

  it("omits sessionUsage when the store has no entry", async () => {
    const file = writeTranscript("nousage.jsonl", [
      { type: "message", id: "u1", message: { role: "user", content: "hi" } },
    ]);
    setForward({ "agent:main:main": { sessionId: "s", sessionFile: file } });

    const res = new MockRes();
    await handleHistoryMessages(
      makeReq("/friday-next/history/messages?sessionKey=agent:main:main", AUTH),
      res as any,
    );
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
      makeReq(
        "/friday-next/history/messages?sessionKey=agent:main:friday:direct:ABCD-1234:9",
        AUTH,
      ),
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

  it("does not double user photos that have both media-attached markers and inline image blocks", async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-inbound-"));
    const a = path.join(srcDir, "photo-a.jpg");
    const b = path.join(srcDir, "photo-b.jpg");
    fs.writeFileSync(a, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    fs.writeFileSync(b, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x11]));
    const file = writeTranscript("media-dup.jsonl", [
      {
        type: "message",
        id: "u1",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: `这是我昨天和今天吃的，记录一下\n\n[media attached: file://${a}]\n[media attached: file://${b}]`,
            },
            { type: "image", mimeType: "image/jpeg", data: "AAA" },
            { type: "image", mimeType: "image/jpeg", data: "BBB" },
          ],
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
    expect(userMsg.images).toHaveLength(2);
    expect(userMsg.images.every((img: any) => img.url?.startsWith("/friday-next/files/"))).toBe(
      true,
    );
    expect(userMsg.images.some((img: any) => img.data)).toBe(false);
    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  it("reports pagination metadata on the tail page (offset 0)", async () => {
    const file = writeTranscript("page-tail.jsonl", [
      { type: "session", version: 1, sessionId: "s" },
      ...[1, 2, 3, 4, 5].map((n) => ({
        type: "message",
        id: `m${n}`,
        timestamp: `2026-01-01T00:00:0${n}.000Z`,
        message: { role: "user", content: `msg ${n}` },
      })),
    ]);
    setForward({ "agent:main:main": { sessionId: "s", sessionFile: file } });

    const res = new MockRes();
    await handleHistoryMessages(
      makeReq("/friday-next/history/messages?sessionKey=agent:main:main", AUTH),
      res as any,
    );
    const body = JSON.parse(res.body);
    expect(body.pagination).toEqual({
      offset: 0,
      limit: 200,
      totalRecords: 5,
      hasMore: false,
    });
  });

  it("pages backwards through raw records with offset, keeping global seq", async () => {
    const file = writeTranscript("page-back.jsonl", [
      ...[1, 2, 3, 4, 5].map((n) => ({
        type: "message",
        id: `m${n}`,
        timestamp: `2026-01-01T00:00:0${n}.000Z`,
        message: { role: "user", content: `msg ${n}` },
      })),
    ]);
    setForward({ "agent:main:main": { sessionId: "s", sessionFile: file } });

    const first = new MockRes();
    await handleHistoryMessages(
      makeReq("/friday-next/history/messages?sessionKey=agent:main:main&limit=2", AUTH),
      first as any,
    );
    const firstBody = JSON.parse(first.body);
    expect(firstBody.messages.map((m: any) => m.id)).toEqual(["m4", "m5"]);
    // seq 是全量记录上的全局序号（m1..m5 → 1..5），跨页拼接后仍可稳定排序。
    expect(firstBody.messages.map((m: any) => m.seq)).toEqual([4, 5]);
    expect(firstBody.pagination).toEqual({
      offset: 0,
      limit: 2,
      totalRecords: 5,
      hasMore: true,
      nextOffset: 2,
    });

    const second = new MockRes();
    await handleHistoryMessages(
      makeReq(
        "/friday-next/history/messages?sessionKey=agent:main:main&limit=2&offset=2",
        AUTH,
      ),
      second as any,
    );
    const secondBody = JSON.parse(second.body);
    expect(secondBody.messages.map((m: any) => m.id)).toEqual(["m2", "m3"]);
    expect(secondBody.pagination.nextOffset).toBe(4);

    const third = new MockRes();
    await handleHistoryMessages(
      makeReq(
        "/friday-next/history/messages?sessionKey=agent:main:main&limit=2&offset=4",
        AUTH,
      ),
      third as any,
    );
    const thirdBody = JSON.parse(third.body);
    expect(thirdBody.messages.map((m: any) => m.id)).toEqual(["m1"]);
    expect(thirdBody.pagination).toEqual({
      offset: 4,
      limit: 2,
      totalRecords: 5,
      hasMore: false,
    });
  });

  it("returns an empty page when offset reaches past the oldest record", async () => {
    const file = writeTranscript("page-past.jsonl", [
      { type: "message", id: "m1", message: { role: "user", content: "only" } },
    ]);
    setForward({ "agent:main:main": { sessionId: "s", sessionFile: file } });

    const res = new MockRes();
    await handleHistoryMessages(
      makeReq(
        "/friday-next/history/messages?sessionKey=agent:main:main&offset=99",
        AUTH,
      ),
      res as any,
    );
    const body = JSON.parse(res.body);
    expect(body.messages).toEqual([]);
    expect(body.pagination).toEqual({
      offset: 99,
      limit: 200,
      totalRecords: 1,
      hasMore: false,
    });
  });

  it("rejects a negative or fractional offset with 400", async () => {
    for (const bad of ["-1", "1.5", "abc"]) {
      const res = new MockRes();
      await handleHistoryMessages(
        makeReq(
          `/friday-next/history/messages?sessionKey=agent:main:main&offset=${bad}`,
          AUTH,
        ),
        res as any,
      );
      expect(res.statusCode).toBe(400);
    }
  });

  it("never uses the tail-only subagent fallback for an offset page", async () => {
    // 旧宿主回退（sessions.get 尾部语义）不能服务 offset 页：拿到的会是错误的窗口。
    const getSessionMessages = vi.fn(async () => ({
      messages: [{ role: "assistant", content: "fallback", __openclaw: { id: "a1", seq: 1 } }],
    }));
    setForward({}); // 无 transcript 行 → 主路径空
    setRuntime(getSessionMessages);

    const res = new MockRes();
    await handleHistoryMessages(
      makeReq(
        "/friday-next/history/messages?sessionKey=agent:main:main&offset=200",
        AUTH,
      ),
      res as any,
    );
    const body = JSON.parse(res.body);
    expect(body.messages).toEqual([]);
    expect(getSessionMessages).not.toHaveBeenCalled();
  });

  it("serves the tail page via gateway sessions.get with a +1 hasMore probe", async () => {
    // 会话共 5 条；请求 limit=2 → gateway 收到 limit+1=3，返回尾部 3 条。
    const gatewayRequest = vi.fn(async (method: string, params: any) => {
      if (method !== "sessions.get") throw new Error(`unexpected ${method}`);
      const all = [1, 2, 3, 4, 5].map((n) => ({
        role: "user",
        content: `msg ${n}`,
        __openclaw: { id: `m${n}`, seq: n },
      }));
      expect(params.key).toBe("agent:main:main");
      return { messages: all.slice(Math.max(0, all.length - params.limit)) };
    });
    setForward({}, { gatewayRequest });

    const res = new MockRes();
    await handleHistoryMessages(
      makeReq("/friday-next/history/messages?sessionKey=agent:main:main&limit=2", AUTH),
      res as any,
    );
    const body = JSON.parse(res.body);
    expect(body.messages.map((m: any) => m.id)).toEqual(["m4", "m5"]);
    expect(body.pagination.hasMore).toBe(true);
    expect(body.pagination.nextOffset).toBe(2);
  });

  it("serves an offset page by windowing the gateway tail read", async () => {
    const gatewayRequest = vi.fn(async (_method: string, params: any) => {
      const all = [1, 2, 3, 4, 5].map((n) => ({
        role: "user",
        content: `msg ${n}`,
        __openclaw: { id: `m${n}`, seq: n },
      }));
      return { messages: all.slice(Math.max(0, all.length - params.limit)) };
    });
    setForward({}, { gatewayRequest });

    const res = new MockRes();
    await handleHistoryMessages(
      makeReq(
        "/friday-next/history/messages?sessionKey=agent:main:main&limit=2&offset=2",
        AUTH,
      ),
      res as any,
    );
    const body = JSON.parse(res.body);
    // offset=2 → gateway 取尾部 4 条，切窗 [m2, m3]。
    expect(body.messages.map((m: any) => m.id)).toEqual(["m2", "m3"]);
    expect(body.pagination.hasMore).toBe(true);
    expect(body.pagination.nextOffset).toBe(4);

    const last = new MockRes();
    await handleHistoryMessages(
      makeReq(
        "/friday-next/history/messages?sessionKey=agent:main:main&limit=2&offset=4",
        AUTH,
      ),
      last as any,
    );
    const lastBody = JSON.parse(last.body);
    expect(lastBody.messages.map((m: any) => m.id)).toEqual(["m1"]);
    expect(lastBody.pagination.hasMore).toBe(false);
  });

  it("falls back to the local transcript read when gateway sessions.get fails", async () => {
    const file = writeTranscript("gw-fallback.jsonl", [
      { type: "message", id: "m1", message: { role: "user", content: "local" } },
    ]);
    const gatewayRequest = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });
    setForward({ "agent:main:main": { sessionId: "s", sessionFile: file } }, { gatewayRequest });

    const res = new MockRes();
    await handleHistoryMessages(
      makeReq("/friday-next/history/messages?sessionKey=agent:main:main", AUTH),
      res as any,
    );
    const body = JSON.parse(res.body);
    expect(body.messages.map((m: any) => m.text)).toEqual(["local"]);
    expect(body.pagination.totalRecords).toBe(1);
  });

  it("falls back to getSessionMessages when the transcript is not on disk", async () => {
    setForward({}); // no entry → disk read yields nothing
    setRuntime(async () => ({
      messages: [{ role: "assistant", content: "fallback", __openclaw: { id: "a1", seq: 1 } }],
    }));
    const res = new MockRes();
    await handleHistoryMessages(
      makeReq("/friday-next/history/messages?sessionKey=agent:main:main", AUTH),
      res as any,
    );
    const body = JSON.parse(res.body);
    expect(body.messages.map((m: any) => m.id)).toEqual(["a1"]);
  });

  it("reads SQLite transcript events when there is no JSONL file", async () => {
    setForward(
      {
        "agent:main:main": { sessionId: "sid-sql", updatedAt: 1 },
      },
      {
        getSessionEntry: true,
        loadTranscriptEventsSync: ({ sessionId }) => {
          if (sessionId !== "sid-sql") return [];
          return [
            { type: "session", id: "sid-sql" },
            {
              type: "message",
              id: "u1",
              timestamp: "2026-01-01T00:00:00.000Z",
              message: { role: "user", content: "from sqlite" },
            },
            {
              type: "message",
              id: "a1",
              timestamp: "2026-01-01T00:00:01.000Z",
              message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
            },
          ];
        },
      },
    );
    const res = new MockRes();
    await handleHistoryMessages(
      makeReq("/friday-next/history/messages?sessionKey=agent:main:main", AUTH),
      res as any,
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessionId).toBe("sid-sql");
    expect(body.messages.map((m: { role: string; text?: string }) => [m.role, m.text])).toEqual([
      ["user", "from sqlite"],
      ["assistant", "ok"],
    ]);
  });

  it("returns the session displayName as title so the app can heal a missed AI title", async () => {
    const file = writeTranscript("titled.jsonl", [
      { type: "message", id: "u1", message: { role: "user", content: "hi" } },
    ]);
    setForward({
      "agent:main:main": { sessionId: "s", sessionFile: file, displayName: "长诗创作请求" },
    });

    const res = new MockRes();
    await handleHistoryMessages(
      makeReq("/friday-next/history/messages?sessionKey=agent:main:main", AUTH),
      res as any,
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.title).toBe("长诗创作请求");
  });

  it("omits title for unnamed sessions", async () => {
    const file = writeTranscript("untitled.jsonl", [
      { type: "message", id: "u1", message: { role: "user", content: "hi" } },
    ]);
    setForward({ "agent:main:main": { sessionId: "s", sessionFile: file } });

    const res = new MockRes();
    await handleHistoryMessages(
      makeReq("/friday-next/history/messages?sessionKey=agent:main:main", AUTH),
      res as any,
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).title).toBeUndefined();
  });
});

describe("handleHistoryMessageDetail", () => {
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

  it("returns one entry at full fidelity (no truncation)", async () => {
    const file = writeTranscript("detail.jsonl", [
      {
        type: "message",
        id: "big-1",
        message: {
          role: "toolResult",
          toolCallId: "tc",
          toolName: "exec",
          content: [{ type: "text", text: "z".repeat(20_000) }],
        },
      },
    ]);
    setForward({ "agent:main:main": { sessionId: "s", sessionFile: file } });

    const res = new MockRes();
    await handleHistoryMessageDetail(
      makeReq(
        "/friday-next/history/message-detail?sessionKey=agent:main:main&id=big-1",
        AUTH,
      ),
      res as any,
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.message.toolResult.text.length).toBe(20_000);
    expect(body.message.truncated).toBeUndefined();
  });

  it("404s for an unknown id", async () => {
    const file = writeTranscript("detail-miss.jsonl", [
      { type: "message", id: "m1", message: { role: "user", content: "hi" } },
    ]);
    setForward({ "agent:main:main": { sessionId: "s", sessionFile: file } });

    const res = new MockRes();
    await handleHistoryMessageDetail(
      makeReq(
        "/friday-next/history/message-detail?sessionKey=agent:main:main&id=nope",
        AUTH,
      ),
      res as any,
    );
    expect(res.statusCode).toBe(404);
  });

  it("400s when sessionKey or id is missing", async () => {
    const res = new MockRes();
    await handleHistoryMessageDetail(
      makeReq("/friday-next/history/message-detail?sessionKey=agent:main:main", AUTH),
      res as any,
    );
    expect(res.statusCode).toBe(400);
  });
});

describe("serverLocalPathForImageUrl", () => {
  it("keeps POSIX absolute and file:// URLs as local paths", () => {
    expect(serverLocalPathForImageUrl("/Users/me/a.jpg")).toBe("/Users/me/a.jpg");
    expect(serverLocalPathForImageUrl("file:///Users/me/a.jpg")).toBe("/Users/me/a.jpg");
  });

  it("treats Windows drive paths as local even on a POSIX test host", () => {
    expect(
      serverLocalPathForImageUrl("C:\\Users\\tempuser\\.openclaw\\media\\inbound\\a.jpg"),
    ).toBe("C:\\Users\\tempuser\\.openclaw\\media\\inbound\\a.jpg");
    expect(serverLocalPathForImageUrl("C:/Users/tempuser/.openclaw/media/inbound/a.jpg")).toBe(
      "C:/Users/tempuser/.openclaw/media/inbound/a.jpg",
    );
  });

  it("decodes file:///C:/ URLs via fileURLToPath", () => {
    const href = "file:///C:/Users/tempuser/.openclaw/media/inbound/a.jpg";
    expect(serverLocalPathForImageUrl(href)).toBe(fileURLToPath(href));
  });

  it("does not treat gateway or remote URLs as local files", () => {
    expect(serverLocalPathForImageUrl("/friday-next/files/abc")).toBeNull();
    expect(serverLocalPathForImageUrl("https://example.com/a.jpg")).toBeNull();
    expect(serverLocalPathForImageUrl("data:image/png;base64,xx")).toBeNull();
  });
});
