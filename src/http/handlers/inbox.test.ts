import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cronResultStore, setInboxV2RootForTest } from "../../inbox/cron-result-store.js";
import { setRuntimeV3RootForTest } from "../../runtime-v3/runtime-store.js";
import { setMockRuntime } from "../../test-support/mock-runtime.js";
import { handleInbox } from "./inbox.js";

const { dispatchGatewayMethod } = vi.hoisted(() => ({ dispatchGatewayMethod: vi.fn() }));

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({ dispatchGatewayMethod }));

type IncomingMessageLike = import("node:http").IncomingMessage;
type ServerResponseLike = import("node:http").ServerResponse;

let root = "";

function makeReq(method: string, url: string, body?: unknown): IncomingMessageLike {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")],
  ) as unknown as IncomingMessageLike;
  req.method = method;
  req.url = url;
  req.headers = {};
  return req;
}

async function invoke(method: string, url: string, body?: unknown) {
  const captured = { status: 200, body: "" };
  const res = {
    get statusCode() {
      return captured.status;
    },
    set statusCode(value: number) {
      captured.status = value;
    },
    setHeader() {},
    end(chunk?: string | Buffer) {
      captured.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : (chunk ?? "");
    },
  } as unknown as ServerResponseLike;
  await handleInbox(makeReq(method, url, body), res);
  return { status: captured.status, json: JSON.parse(captured.body) as Record<string, unknown> };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-inbox-route-"));
  setMockRuntime({ historyDir: path.join(root, "history") });
  setInboxV2RootForTest(path.join(root, "inbox-v2"));
  setRuntimeV3RootForTest(path.join(root, "runtime-v3"));
  cronResultStore.resetForTest();
  dispatchGatewayMethod.mockReset();
});

afterEach(() => {
  setInboxV2RootForTest(null);
  setRuntimeV3RootForTest(null);
  cronResultStore.resetForTest();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("inbox snapshot", () => {
  it("返回增量 cron 和三个完整 attention 分类，并标注 scopeUpgrade unsupported", async () => {
    cronResultStore.append({
      sourceIdentity: "run:r1",
      category: "cronResults",
      kind: "cronResult",
      lifecycle: "event",
      occurredAtMs: 10,
      deviceId: "PHONE-A",
      jobId: "done",
      agentId: "main",
      status: "ok",
      summary: "已完成",
    });
    dispatchGatewayMethod.mockImplementation(async (method: string) => {
      if (method === "exec.approval.list") {
        return {
          ok: true,
          payload: [
            {
              id: "exec-1",
              createdAtMs: Date.now() - 10,
              expiresAtMs: Date.now() + 60_000,
              request: { command: "pnpm test" },
            },
          ],
        };
      }
      if (method === "plugin.approval.list" || method === "openclaw.approval.list") {
        return { ok: true, payload: [] };
      }
      if (method === "cron.list") {
        return {
          ok: true,
          payload: {
            jobs: [
              {
                id: "failed",
                name: "失败任务",
                enabled: true,
                state: { lastRunStatus: "error", lastRunAtMs: 20 },
              },
            ],
            total: 1,
          },
        };
      }
      if (method === "cron.status") return { ok: true, payload: { enabled: true } };
      if (method === "models.authStatus") {
        return {
          ok: true,
          payload: {
            ts: 30,
            providers: [
              {
                provider: "anthropic",
                displayName: "Anthropic",
                status: "expired",
                profiles: [{ profileId: "oauth", type: "oauth", status: "expired" }],
              },
            ],
          },
        };
      }
      if (method === "update.status") {
        return { ok: true, payload: { updateAvailable: null, sentinel: null } };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const result = await invoke(
      "GET",
      "/friday-next-admin/inbox/snapshot?deviceId=phone-a&agentId=main&afterCursor=0",
    );
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      schemaVersion: 2,
      cursor: 1,
      cronResults: [expect.objectContaining({ kind: "cronResult", jobId: "done" })],
      attention: {
        approvals: [expect.objectContaining({ kind: "execApproval" })],
        automations: [expect.objectContaining({ kind: "cronFailed" })],
        system: [expect.objectContaining({ kind: "modelAuthExpired" })],
      },
      sources: { scopeUpgrade: { status: "unsupported" } },
    });
  });

  it("单个 gateway 数据源失败时保留其 stale 状态，不让整个快照失败", async () => {
    dispatchGatewayMethod.mockImplementation(async (method: string) => {
      if (method === "models.authStatus") throw new Error("auth temporarily unavailable");
      if (method === "cron.list") return { ok: true, payload: { jobs: [], total: 0 } };
      if (method === "cron.status") return { ok: true, payload: { enabled: true } };
      if (method === "update.status") {
        return { ok: true, payload: { updateAvailable: null, sentinel: null } };
      }
      return { ok: true, payload: [] };
    });
    const result = await invoke(
      "GET",
      "/friday-next-admin/inbox/snapshot?deviceId=phone-a&afterCursor=0",
    );
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      sources: { modelAuth: { status: "stale", detail: "auth temporarily unavailable" } },
    });
  });
});

describe("inbox approval resolve", () => {
  it("按类型转发到原生 resolve，并原样保留不透明 id", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { ok: true } });
    const result = await invoke("POST", "/friday-next-admin/inbox/approvals/resolve", {
      approvalId: " opaque/id ",
      kind: "system-agent",
      decision: "deny",
    });
    expect(result.status).toBe(200);
    expect(dispatchGatewayMethod).toHaveBeenCalledWith("approval.resolve", {
      id: " opaque/id ",
      kind: "system-agent",
      decision: "deny",
    });
  });

  it("已解决或已过期按幂等成功处理", async () => {
    dispatchGatewayMethod.mockResolvedValue({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "approval resolve rejected",
        details: { reason: "APPROVAL_ALREADY_RESOLVED" },
      },
    });
    const result = await invoke("POST", "/friday-next-admin/inbox/approvals/resolve", {
      approvalId: "exec-1",
      kind: "exec",
      decision: "allow-once",
    });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ ok: true, approvalId: "exec-1" });
  });

  it("拒绝 system-agent 不支持的永久授权", async () => {
    const result = await invoke("POST", "/friday-next-admin/inbox/approvals/resolve", {
      approvalId: "system-1",
      kind: "system-agent",
      decision: "allow-always",
    });
    expect(result.status).toBe(400);
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });
});
