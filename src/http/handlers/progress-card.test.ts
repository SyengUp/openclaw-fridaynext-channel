import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({
  dispatchGatewayMethod: dispatchMock,
}));

import { handleProgressCardGet } from "./progress-card.js";
import { setFridayNextRuntime } from "../../runtime.js";

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
const CFG = {
  channels: { "friday-next": { authToken: "test-token", pathPrefix: "/friday-next" } },
  gateway: { auth: { token: "test-token" } },
};

function makeReq(query: string | null, headers: Record<string, string> = AUTH): IncomingMessage {
  return {
    method: "GET",
    url:
      query == null
        ? "/friday-next/progress-card"
        : `/friday-next/progress-card?sessionKey=${encodeURIComponent(query)}`,
    headers,
  } as unknown as IncomingMessage;
}

async function invoke(req: IncomingMessage): Promise<MockRes> {
  const res = new MockRes();
  await handleProgressCardGet(req, res as unknown as ServerResponse);
  return res;
}

describe("handleProgressCardGet", () => {
  beforeEach(() => {
    dispatchMock.mockReset();
    setFridayNextRuntime({ config: { loadConfig: () => CFG }, logger: {} } as never);
  });

  it("rejects missing token with 401", async () => {
    const res = await invoke(makeReq("agent:main:main", {}));
    expect(res.statusCode).toBe(401);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("400s without sessionKey", async () => {
    const res = await invoke(makeReq(null));
    expect(res.statusCode).toBe(400);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("returns the card payload from progressCard.get", async () => {
    dispatchMock.mockResolvedValue({
      ok: true,
      payload: {
        card: {
          sessionKey: "agent:main:main",
          revision: 3,
          updatedAt: 123,
          steps: [{ step: "修复", status: "in_progress" }],
        },
      },
    });
    const res = await invoke(makeReq("agent:main:main"));
    expect(res.statusCode).toBe(200);
    expect(dispatchMock).toHaveBeenCalledWith("progressCard.get", {
      sessionKey: "agent:main:main",
    });
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.card.revision).toBe(3);
    expect(body.card.steps[0].step).toBe("修复");
  });

  it("returns null card when the session has none", async () => {
    dispatchMock.mockResolvedValue({ ok: true, payload: { card: null } });
    const res = await invoke(makeReq("agent:main:main"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).card).toBeNull();
  });

  it("propagates gateway errors as 502", async () => {
    dispatchMock.mockResolvedValue({ ok: false, error: { message: "no method" } });
    const res = await invoke(makeReq("agent:main:main"));
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).ok).toBe(false);
  });
});
