// Tests for DELETE /friday-next-admin/sessions — permanent server-side session
// deletion via the canonical gateway `sessions.delete` method.
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleSessionDelete } from "./session-delete.js";

const { dispatchGatewayMethod } = vi.hoisted(() => ({
  dispatchGatewayMethod: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({
  dispatchGatewayMethod,
}));

type Captured = { statusCode: number; headers: Record<string, unknown>; body: string };

function makeReq(method: string, url: string): IncomingMessageLike {
  const req = Readable.from([]) as unknown as IncomingMessageLike;
  req.method = method;
  req.url = url;
  req.headers = {};
  return req;
}

function makeRes(): { res: ServerResponseLike; captured: Captured } {
  const captured: Captured = { statusCode: 200, headers: {}, body: "" };
  const res = {
    get statusCode() {
      return captured.statusCode;
    },
    set statusCode(v: number) {
      captured.statusCode = v;
    },
    setHeader(name: string, value: unknown) {
      captured.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string | Buffer) {
      captured.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : (chunk ?? "");
    },
  } as unknown as ServerResponseLike;
  return { res, captured };
}

type IncomingMessageLike = import("node:http").IncomingMessage;
type ServerResponseLike = import("node:http").ServerResponse;

async function invoke(method: string, url: string) {
  const { res, captured } = makeRes();
  const handled = await handleSessionDelete(makeReq(method, url), res);
  return {
    handled,
    captured,
    json: captured.body ? (JSON.parse(captured.body) as Record<string, unknown>) : undefined,
  };
}

describe("handleSessionDelete", () => {
  beforeEach(() => {
    dispatchGatewayMethod.mockReset();
  });

  it("dispatches sessions.delete and returns 200 on success", async () => {
    dispatchGatewayMethod.mockResolvedValue({
      ok: true,
      payload: { ok: true, key: "agent:main:abc", deleted: true, archived: ["/x.jsonl.deleted.T"] },
    });

    const { captured, json } = await invoke(
      "DELETE",
      "/friday-next-admin/sessions?sessionKey=agent:main:abc",
    );

    expect(dispatchGatewayMethod).toHaveBeenCalledWith("sessions.delete", {
      key: "agent:main:abc",
      deleteTranscript: true,
    });
    expect(captured.statusCode).toBe(200);
    expect(json).toMatchObject({
      ok: true,
      sessionKey: "agent:main:abc",
      deleted: true,
      archived: ["/x.jsonl.deleted.T"],
    });
  });

  it("returns 400 and does not dispatch when sessionKey is missing", async () => {
    const { captured } = await invoke("DELETE", "/friday-next-admin/sessions");
    expect(captured.statusCode).toBe(400);
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("returns 405 for non-DELETE methods", async () => {
    const { captured } = await invoke(
      "GET",
      "/friday-next-admin/sessions?sessionKey=agent:main:abc",
    );
    expect(captured.statusCode).toBe(405);
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("maps an INVALID_REQUEST gateway error (e.g. main session) to 400", async () => {
    dispatchGatewayMethod.mockResolvedValue({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "Cannot delete the main session (agent:main:main)" },
    });

    const { captured, json } = await invoke(
      "DELETE",
      "/friday-next-admin/sessions?sessionKey=agent:main:main",
    );

    expect(captured.statusCode).toBe(400);
    expect(json).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });

  it("returns 500 when dispatch throws", async () => {
    dispatchGatewayMethod.mockRejectedValue(new Error("dispatch reserved for contracts"));
    const { captured, json } = await invoke(
      "DELETE",
      "/friday-next-admin/sessions?sessionKey=agent:main:abc",
    );
    expect(captured.statusCode).toBe(500);
    expect(json).toMatchObject({ ok: false });
  });
});
