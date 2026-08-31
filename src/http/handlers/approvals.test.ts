import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMockRuntime } from "../../test-support/mock-runtime.js";

const { resolveApprovalOverGateway } = vi.hoisted(() => ({
  resolveApprovalOverGateway: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway,
}));

import { handleApprovalDecision } from "./approvals.js";

type IncomingMessageLike = import("node:http").IncomingMessage;
type ServerResponseLike = import("node:http").ServerResponse;
type Captured = { statusCode: number; body: string };

function makeReq(method: string, body?: unknown, token = "test-token"): IncomingMessageLike {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf-8")];
  const req = Readable.from(payload) as unknown as IncomingMessageLike;
  req.method = method;
  req.url = "/friday-next/approvals/exec-1";
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  return req;
}

function makeRes(): { res: ServerResponseLike; captured: Captured } {
  const captured: Captured = { statusCode: 200, body: "" };
  const res = {
    get statusCode() {
      return captured.statusCode;
    },
    set statusCode(v: number) {
      captured.statusCode = v;
    },
    setHeader() {},
    end(chunk?: string | Buffer) {
      captured.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : (chunk ?? "");
    },
  } as unknown as ServerResponseLike;
  return { res, captured };
}

async function invoke(method: string, approvalId: string, body?: unknown, token?: string) {
  const { res, captured } = makeRes();
  await handleApprovalDecision(makeReq(method, body, token), res, approvalId);
  return {
    status: captured.statusCode,
    json: captured.body ? (JSON.parse(captured.body) as Record<string, unknown>) : undefined,
  };
}

describe("handleApprovalDecision", () => {
  beforeEach(() => {
    setMockRuntime();
    resolveApprovalOverGateway.mockReset();
    resolveApprovalOverGateway.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects missing bearer", async () => {
    const result = await invoke("POST", "exec-1", { decision: "allow-once" }, "");
    expect(result.status).toBe(401);
    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("rejects unknown decisions", async () => {
    const result = await invoke("POST", "exec-1", { decision: "approve" });
    expect(result.status).toBe(400);
    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("does not pass a lone senderId when the app includes deviceId", async () => {
    const result = await invoke("POST", "exec-1", {
      decision: "allow-once",
      deviceId: "iphone-abc",
    });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      ok: true,
      approvalId: "exec-1",
      decision: "allow-once",
    });
    expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(1);
    const params = resolveApprovalOverGateway.mock.calls[0][0] as Record<string, unknown>;
    expect(params).not.toHaveProperty("senderId");
    expect(params).not.toHaveProperty("channel");
    expect(params).not.toHaveProperty("accountId");
    expect(params.approvalId).toBe("exec-1");
    expect(params.decision).toBe("allow-once");
    expect(params.allowPluginFallback).toBe(true);
    expect(params.clientDisplayName).toBe("Friday Next (IPHONE-ABC)");
  });

  it("still resolves when the body omits deviceId", async () => {
    const result = await invoke("POST", "plugin:abc", { decision: "deny" });
    expect(result.status).toBe(200);
    const params = resolveApprovalOverGateway.mock.calls[0][0] as Record<string, unknown>;
    expect(params).not.toHaveProperty("senderId");
    expect(params.clientDisplayName).toBe("Friday Next");
    expect(params.decision).toBe("deny");
  });

  it("returns 502 when the gateway resolver throws", async () => {
    resolveApprovalOverGateway.mockRejectedValue(
      new Error("channel approval resolution requires channel, account, and sender identity"),
    );
    const result = await invoke("POST", "exec-1", {
      decision: "allow-once",
      deviceId: "DEV1",
    });
    expect(result.status).toBe(502);
    expect(result.json?.error).toBe("Approval resolution failed");
  });
});
