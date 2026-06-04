import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { handleHistorySetTitle } from "./history-set-title.js";
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

function makeReq(bodyObj: unknown, headers: Record<string, string> = {}, method = "PUT"): any {
  const req = Readable.from([Buffer.from(JSON.stringify(bodyObj))]) as any;
  req.method = method;
  req.url = "/friday-next/sessions/title";
  req.headers = headers;
  return req;
}

const AUTH = { authorization: "Bearer test-token" };
const CFG = {
  channels: { "friday-next": { authToken: "test-token", pathPrefix: "/friday-next" } },
  gateway: { auth: { token: "test-token" } },
};

let captured: { storePath: string; sessionKey: string; patch: unknown } | null = null;

function setForward(store: Record<string, unknown>, withWriter = true): void {
  captured = null;
  setFridayAgentForwardRuntime({
    runtime: {
      agent: {
        session: {
          resolveStorePath: (_s?: string, opts?: { agentId?: string }) => `/store/${opts?.agentId ?? "main"}.json`,
          loadSessionStore: () => store,
          ...(withWriter
            ? {
                updateSessionStoreEntry: async (params: any) => {
                  const patch = await params.update({ sessionId: "sess-1" });
                  captured = { storePath: params.storePath, sessionKey: params.sessionKey, patch };
                  return { sessionId: "sess-1", ...patch };
                },
              }
            : {}),
        },
      },
      config: { current: () => CFG },
    },
  } as any);
}

describe("handleHistorySetTitle", () => {
  beforeEach(() => setFridayNextRuntime({ config: { loadConfig: () => CFG }, logger: {} } as never));
  afterEach(() => resetFridayAgentForwardRuntimeForTest());

  it("rejects GET with 405", async () => {
    setForward({});
    const res = new MockRes();
    await handleHistorySetTitle(makeReq({}, AUTH, "GET"), res as any);
    expect(res.statusCode).toBe(405);
  });

  it("rejects missing token with 401", async () => {
    setForward({});
    const res = new MockRes();
    await handleHistorySetTitle(makeReq({ sessionKey: "agent:main:main", title: "x" }), res as any);
    expect(res.statusCode).toBe(401);
  });

  it("400s without sessionKey", async () => {
    setForward({});
    const res = new MockRes();
    await handleHistorySetTitle(makeReq({ title: "x" }, AUTH), res as any);
    expect(res.statusCode).toBe(400);
  });

  it("writes displayName for the resolved (case-insensitive) store key", async () => {
    setForward({ "agent:main:friday:direct:abcd:9": { sessionId: "sess-1" } });
    const res = new MockRes();
    await handleHistorySetTitle(
      makeReq({ sessionKey: "agent:main:friday:direct:ABCD:9", title: "My Chat" }, AUTH),
      res as any,
    );
    expect(res.statusCode).toBe(200);
    expect(captured?.sessionKey).toBe("agent:main:friday:direct:abcd:9");
    expect(captured?.patch).toEqual({ displayName: "My Chat" });
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ ok: true, sessionId: "sess-1", title: "My Chat" });
  });

  it("404s when the session is unknown", async () => {
    setForward({});
    const res = new MockRes();
    await handleHistorySetTitle(makeReq({ sessionKey: "agent:main:nope", title: "x" }, AUTH), res as any);
    expect(res.statusCode).toBe(404);
  });

  it("503s when the store writer is unavailable", async () => {
    setForward({ "agent:main:main": { sessionId: "s" } }, false);
    const res = new MockRes();
    await handleHistorySetTitle(makeReq({ sessionKey: "agent:main:main", title: "x" }, AUTH), res as any);
    expect(res.statusCode).toBe(503);
  });
})
