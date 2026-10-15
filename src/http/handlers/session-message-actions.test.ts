import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleSessionFork, handleSessionRewind } from "./session-message-actions.js";

const { dispatch, gate, runs, bindConversation } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  gate: vi.fn(),
  runs: vi.fn(),
  bindConversation: vi.fn(),
}));
vi.mock("../../runtime-v3/runtime-store.js", () => ({
  getRuntimeV3Store: () => ({ runs, bindRunConversation: bindConversation }),
}));
vi.mock("../../history/read-transcript.js", () => ({ resolveSessionId: () => "before" }));
vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({ dispatchGatewayMethod: dispatch }));
vi.mock("../../attest/attest-gate.js", () => ({
  attestGateDecision: gate,
  ATTEST_REJECTION_BODY: { error: "attest required" },
}));
vi.mock("../../runtime.js", () => ({ getFridayNextRuntime: () => ({ config: {} }) }));
vi.mock("../../host-config.js", () => ({ getHostOpenClawConfigSnapshot: () => ({}) }));
vi.mock("../../config.js", () => ({
  resolveFridayNextConfig: () => ({ appAttest: { required: true } }),
}));

async function invoke(action: "rewind" | "fork", body: unknown, method = "POST", isPublic = false) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.method = method;
  req.headers = isPublic ? { "x-fridaynext-public": "1" } : {};
  const captured = { status: 0, body: "" };
  const res = {
    set statusCode(value: number) {
      captured.status = value;
    },
    setHeader() {},
    end(value: string) {
      captured.body = value;
    },
  } as unknown as ServerResponse;
  await (action === "rewind" ? handleSessionRewind : handleSessionFork)(req, res);
  return { status: captured.status, json: JSON.parse(captured.body) as Record<string, unknown> };
}

describe("消息回退与分叉", () => {
  beforeEach(() => {
    dispatch.mockReset();
    runs.mockReset().mockReturnValue([]);
    bindConversation.mockReset();
    gate.mockReset().mockReturnValue("allow");
  });
  const params = { sessionKey: "agent:main:chat", entryId: "user-entry", agentId: "main" };
  it("服务器待发队列同样阻止切点，避免跨设备排队消息进入新路径", async () => {
    runs.mockReturnValue([{ sessionKey: params.sessionKey, runId: "queued", phase: "queued" }]);
    expect((await invoke("rewind", params)).status).toBe(503);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("旧账本任务在切点前绑定原会话身份", async () => {
    runs.mockReturnValue([{ sessionKey: params.sessionKey, runId: "old", phase: "completed" }]);
    dispatch.mockResolvedValue({ ok: true, payload: {} });
    await invoke("rewind", params);
    expect(bindConversation).toHaveBeenCalledWith("old", "before");
  });
  it.each(["rewind", "fork"] as const)("%s 透传核心切点及回填附件", async (action) => {
    const payload = {
      editorText: "原消息",
      editorAttachments: [{ mimeType: "image/png", data: "AQ==" }],
      ...(action === "fork" ? { sessionKey: "agent:main:forked" } : {}),
    };
    dispatch.mockResolvedValue({ ok: true, payload });
    expect(await invoke(action, params)).toEqual({ status: 200, json: { ok: true, ...payload } });
    expect(dispatch).toHaveBeenCalledWith(`sessions.${action}`, params);
  });
  it.each([{}, { ...params, entryId: " " }, { ...params, agentId: 12 }, null, []])(
    "拒绝不完整参数 %j",
    async (body) => {
      expect((await invoke("rewind", body)).status).toBe(400);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );
  it("省略 agentId 时由核心解析归属", async () => {
    dispatch.mockResolvedValue({ ok: true, payload: {} });
    await invoke("rewind", { sessionKey: " agent:main:chat ", entryId: " user-entry " });
    expect(dispatch).toHaveBeenCalledWith("sessions.rewind", {
      sessionKey: params.sessionKey,
      entryId: params.entryId,
    });
  });
  it.each([
    ["INVALID_REQUEST", 400],
    ["UNAVAILABLE", 503],
    ["AGENT_TIMEOUT", 504],
    ["UNKNOWN", 500],
  ] as const)("保留 %s 错误", async (code, status) => {
    dispatch.mockResolvedValue({ ok: false, error: { code, message: "核心拒绝" } });
    expect(await invoke("rewind", params)).toEqual({
      status,
      json: { ok: false, code, error: "核心拒绝" },
    });
  });
  it("调度异常不重试", async () => {
    dispatch.mockRejectedValue(new Error("连接断开"));
    expect((await invoke("fork", params)).status).toBe(500);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("拒绝错误方法", async () => {
    expect((await invoke("rewind", params, "GET")).status).toBe(405);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it.each(["rewind", "fork"] as const)("%s 公网必须经过 Attest", async (action) => {
    gate.mockReturnValue("reject");
    expect((await invoke(action, params, "POST", true)).status).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
    expect(gate).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: `/friday-next-admin/sessions/${action}`,
        required: true,
      }),
    );
  });
});
