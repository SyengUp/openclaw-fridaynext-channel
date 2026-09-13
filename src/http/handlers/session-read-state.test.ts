import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleSessionReadState } from "./session-read-state.js";

const { dispatchGatewayMethod } = vi.hoisted(() => ({
  dispatchGatewayMethod: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({
  dispatchGatewayMethod,
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

async function invoke(method: string, body?: Record<string, unknown>) {
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
  await handleSessionReadState(makeReq(method, body), res);
  return {
    ...captured,
    json: captured.body ? (JSON.parse(captured.body) as Record<string, unknown>) : undefined,
  };
}

describe("handleSessionReadState", () => {
  beforeEach(() => {
    dispatchGatewayMethod.mockReset();
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
