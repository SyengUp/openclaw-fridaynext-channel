import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleSessionReadState } from "./session-read-state.js";
import identityFixture from "./fixtures/foreground-notification-session-identity-2026-10-21.json";

const { dispatchGatewayMethod, nativeByLogical } = vi.hoisted(() => ({
  dispatchGatewayMethod: vi.fn(),
  nativeByLogical: new Map<string, string>(),
}));

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({
  dispatchGatewayMethod,
}));
vi.mock("../../adapters/openclaw/session-metadata.js", () => ({
  mappedNativeSessionKey: (key: string) => nativeByLogical.get(key),
  logicalSessionKey: (key: string) =>
    [...nativeByLogical].find(([, native]) => native === key)?.[0] ?? key,
}));

type IncomingMessageLike = import("node:http").IncomingMessage;
type ServerResponseLike = import("node:http").ServerResponse;

function makeReq(method: string, body?: Record<string, unknown>): IncomingMessageLike {
  const raw = body ? JSON.stringify(body) : "";
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessageLike;
  req.method = method;
  req.url = "/friday-next-admin/sessions/state";
  req.headers = {};
  return req;
}

async function invoke(method: string, body?: Record<string, unknown>, canonical = false) {
  const captured = { statusCode: 200, headers: {} as Record<string, unknown>, body: "" };
  const res = {
    get statusCode() {
      return captured.statusCode;
    },
    set statusCode(value: number) {
      captured.statusCode = value;
    },
    setHeader(name: string, value: unknown) {
      captured.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string | Buffer) {
      captured.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : (chunk ?? "");
    },
  } as unknown as ServerResponseLike;
  const req = makeReq(method, body);
  if (canonical) req.headers["x-fridaynext-event-format"] = "canonical-v1";
  await handleSessionReadState(req, res);
  return {
    ...captured,
    json: captured.body ? (JSON.parse(captured.body) as Record<string, unknown>) : undefined,
  };
}

describe("handleSessionReadState", () => {
  beforeEach(() => {
    dispatchGatewayMethod.mockReset();
    nativeByLogical.clear();
  });

  it("规范清单保留真实通知的逻辑会话身份，避免目录对账误撤销横幅", async () => {
    nativeByLogical.set(identityFixture.logicalSessionKey, identityFixture.nativeSessionKey);
    dispatchGatewayMethod.mockResolvedValue({
      ok: true,
      payload: {
        totalCount: 1,
        hasMore: false,
        sessions: [identityFixture.hostState],
      },
    });

    const result = await invoke("GET", undefined, true);

    expect(result.json).toMatchObject({
      ok: true,
      complete: true,
      states: [
        {
          sessionKey: identityFixture.logicalSessionKey,
          sessionId: identityFixture.hostState.sessionId,
        },
      ],
    });
  });

  it("规范清单不把仅大小写不同的逻辑身份归并", async () => {
    nativeByLogical.set("Opaque/AbC", "agent:main:first");
    nativeByLogical.set("Opaque/abc", "agent:main:second");
    dispatchGatewayMethod.mockResolvedValue({
      ok: true,
      payload: {
        totalCount: 2,
        hasMore: false,
        sessions: [{ key: "agent:main:first" }, { key: "agent:main:second" }],
      },
    });

    const result = await invoke("GET", undefined, true);

    expect(result.json).toEqual({
      ok: true,
      complete: true,
      states: [{ sessionKey: "Opaque/AbC" }, { sessionKey: "Opaque/abc" }],
    });
  });

  it("旧客户端继续取得原生清单身份", async () => {
    nativeByLogical.set(identityFixture.logicalSessionKey, identityFixture.nativeSessionKey);
    dispatchGatewayMethod.mockResolvedValue({
      ok: true,
      payload: {
        totalCount: 1,
        hasMore: false,
        sessions: [identityFixture.hostState],
      },
    });

    const result = await invoke("GET");

    expect(result.json).toMatchObject({
      complete: true,
      states: [{ sessionKey: identityFixture.nativeSessionKey }],
    });
  });

  it("逻辑身份的已读确认交给宿主前映射，保留 session 与未读代际护栏", async () => {
    nativeByLogical.set(identityFixture.logicalSessionKey, identityFixture.nativeSessionKey);
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { ok: true } });

    const result = await invoke(
      "PATCH",
      {
        sessionKey: identityFixture.logicalSessionKey,
        agentId: "operator",
        unread: false,
        expectedSessionId: identityFixture.hostState.sessionId,
        expectedMarkedUnreadAt: 42,
      },
      true,
    );

    expect(dispatchGatewayMethod).toHaveBeenCalledWith("sessions.patch", {
      key: identityFixture.nativeSessionKey,
      agentId: "operator",
      unread: false,
      expectedSessionId: identityFixture.hostState.sessionId,
      expectedMarkedUnreadAt: 42,
    });
    expect(result.json).toEqual({ ok: true, sessionKey: identityFixture.logicalSessionKey });
  });

  it("pages sessions.list and projects only canonical read-state fields", async () => {
    dispatchGatewayMethod
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          totalCount: 2,
          hasMore: true,
          nextOffset: 1,
          sessions: [
            {
              key: "agent:main:first",
              agentId: "main",
              sessionId: "s-1",
              unread: true,
              markedUnreadAt: 42,
              lastActivityAt: 40,
              secret: "must-not-leak",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          totalCount: 2,
          hasMore: false,
          sessions: [
            {
              key: "agent:research:second",
              agentId: "research",
              sessionId: "s-2",
              unread: false,
              lastReadAt: 99,
              status: "failed",
              lastRunError: "boom",
            },
          ],
        },
      });

    const result = await invoke("GET");

    expect(dispatchGatewayMethod).toHaveBeenNthCalledWith(1, "sessions.list", {
      configuredAgentsOnly: true,
      includeGlobal: false,
      includeUnknown: false,
      limit: 250,
      offset: 0,
    });
    expect(dispatchGatewayMethod).toHaveBeenNthCalledWith(2, "sessions.list", {
      configuredAgentsOnly: true,
      includeGlobal: false,
      includeUnknown: false,
      limit: 250,
      offset: 1,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json).toEqual({
      ok: true,
      complete: true,
      states: [
        {
          sessionKey: "agent:main:first",
          agentId: "main",
          sessionId: "s-1",
          unread: true,
          markedUnreadAt: 42,
          lastActivityAt: 40,
        },
        {
          sessionKey: "agent:research:second",
          agentId: "research",
          sessionId: "s-2",
          unread: false,
          lastReadAt: 99,
          status: "failed",
          lastRunError: "boom",
        },
      ],
    });
  });

  it("dispatches a fenced automatic read acknowledgement", async () => {
    dispatchGatewayMethod.mockResolvedValue({
      ok: true,
      payload: { ok: true, key: "agent:main:chat", entry: { lastReadAt: 100 } },
    });

    const result = await invoke("PATCH", {
      sessionKey: "agent:main:chat",
      agentId: "main",
      expectedSessionId: "session-1",
      unread: false,
      expectedMarkedUnreadAt: 42,
    });

    expect(dispatchGatewayMethod).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:chat",
      agentId: "main",
      expectedSessionId: "session-1",
      unread: false,
      expectedMarkedUnreadAt: 42,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json).toEqual({ ok: true, sessionKey: "agent:main:chat" });
  });

  it("preserves an explicit null marker fence", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { ok: true, entry: {} } });

    await invoke("PATCH", {
      sessionKey: "agent:main:chat",
      unread: false,
      expectedMarkedUnreadAt: null,
    });

    expect(dispatchGatewayMethod).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:main:chat",
      unread: false,
      expectedMarkedUnreadAt: null,
    });
  });

  it("rejects malformed mutations before dispatch", async () => {
    const result = await invoke("PATCH", {
      sessionKey: "agent:main:chat",
      unread: "false",
    });

    expect(result.statusCode).toBe(400);
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });
});
