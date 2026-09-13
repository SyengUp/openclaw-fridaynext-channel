import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cronResultStore, setInboxV2RootForTest } from "../../inbox/cron-result-store.js";
import { legacyApprovalStore } from "../../inbox/legacy-approval-store.js";
import { setRuntimeV3RootForTest } from "../../runtime-v3/runtime-store.js";
import { setMockRuntime } from "../../test-support/mock-runtime.js";
import { handleInbox } from "./inbox.js";

const { dispatchGatewayMethod, resolveApprovalOverGateway } = vi.hoisted(() => ({
  dispatchGatewayMethod: vi.fn(),
  resolveApprovalOverGateway: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({ dispatchGatewayMethod }));
vi.mock("../../approval/approval-resolution.js", () => ({
  resolveApprovalViaGateway: resolveApprovalOverGateway,
}));

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
  legacyApprovalStore.resetForTest();
  dispatchGatewayMethod.mockReset();
  resolveApprovalOverGateway.mockReset();
  resolveApprovalOverGateway.mockResolvedValue(undefined);
});

afterEach(() => {
  setInboxV2RootForTest(null);
  setRuntimeV3RootForTest(null);
  cronResultStore.resetForTest();
  legacyApprovalStore.resetForTest();
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

  it("兼容 2026.7.1：cron.list 拒绝 includeDeliveryPreviews 时仅去掉该参数重试", async () => {
    dispatchGatewayMethod.mockImplementation(
      async (method: string, params: Record<string, unknown>) => {
        if (
          method === "exec.approval.list" ||
          method === "plugin.approval.list" ||
          method === "openclaw.approval.list"
        ) {
          return { ok: true, payload: [] };
        }
        if (method === "cron.list") {
          if (Object.hasOwn(params, "includeDeliveryPreviews")) {
            return {
              ok: false,
              error: {
                code: "INVALID_REQUEST",
                message:
                  "invalid cron.list params: at root: unexpected property 'includeDeliveryPreviews'",
              },
            };
          }
          return {
            ok: true,
            payload: {
              jobs: [
                {
                  id: "legacy-failed",
                  name: "旧版失败任务",
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
          return { ok: true, payload: { providers: [] } };
        }
        if (method === "update.status") {
          return { ok: true, payload: { updateAvailable: null, sentinel: null } };
        }
        throw new Error(`unexpected method ${method}`);
      },
    );

    const result = await invoke(
      "GET",
      "/friday-next-admin/inbox/snapshot?deviceId=phone-a&afterCursor=0",
    );

    expect(result.json).toMatchObject({
      attention: { automations: [expect.objectContaining({ kind: "cronFailed" })] },
      sources: { cronJobs: { status: "fresh" } },
    });
    expect(dispatchGatewayMethod.mock.calls.filter(([method]) => method === "cron.list")).toEqual([
      [
        "cron.list",
        expect.objectContaining({ includeDeliveryPreviews: false, includeDisabled: true }),
      ],
      ["cron.list", expect.not.objectContaining({ includeDeliveryPreviews: expect.anything() })],
    ]);
  });

  it("兼容 2026.7.1：仅含 sentinel 的 update.status 是有效快照", async () => {
    dispatchGatewayMethod.mockImplementation(async (method: string) => {
      if (method === "cron.list") return { ok: true, payload: { jobs: [], total: 0 } };
      if (method === "cron.status") return { ok: true, payload: { enabled: true } };
      if (method === "models.authStatus") {
        return { ok: true, payload: { providers: [] } };
      }
      if (method === "update.status") return { ok: true, payload: { sentinel: null } };
      return { ok: true, payload: [] };
    });

    const result = await invoke(
      "GET",
      "/friday-next-admin/inbox/snapshot?deviceId=phone-a&afterCursor=0",
    );

    expect(result.json).toMatchObject({
      attention: { system: [] },
      sources: { update: { status: "fresh" } },
    });
  });

  it("兼容 2026.7.1：pending-list 方法不存在时读取结构化审批镜像", async () => {
    legacyApprovalStore.upsert({
      op: "request",
      approvalId: "legacy-exec-1",
      kind: "exec",
      title: "命令审批",
      commandText: "pnpm test",
      cwd: "/workspace",
      metadata: [],
      actions: [],
      expiresAtMs: Date.now() + 60_000,
      deviceId: "",
      ts: Date.now() - 100,
    });
    dispatchGatewayMethod.mockImplementation(async (method: string) => {
      if (
        method === "exec.approval.list" ||
        method === "plugin.approval.list" ||
        method === "openclaw.approval.list"
      ) {
        return {
          ok: false,
          error: { code: "INVALID_REQUEST", message: `unknown method: ${method}` },
        };
      }
      if (method === "cron.list") return { ok: true, payload: { jobs: [], total: 0 } };
      if (method === "cron.status") return { ok: true, payload: { enabled: true } };
      if (method === "models.authStatus") return { ok: true, payload: { providers: [] } };
      if (method === "update.status") return { ok: true, payload: { sentinel: null } };
      throw new Error(`unexpected method ${method}`);
    });

    const result = await invoke(
      "GET",
      "/friday-next-admin/inbox/snapshot?deviceId=phone-a&afterCursor=0",
    );

    expect(result.json).toMatchObject({
      attention: {
        approvals: [
          expect.objectContaining({
            id: "approval:exec:legacy-exec-1",
            kind: "execApproval",
            title: "pnpm test",
          }),
        ],
      },
      sources: {
        execApprovals: { status: "fresh" },
        pluginApprovals: { status: "fresh" },
        systemAgentApprovals: { status: "fresh" },
      },
    });
  });

  it("审批列表的瞬时失败不得回退镜像并伪装成 fresh", async () => {
    legacyApprovalStore.upsert({
      op: "request",
      approvalId: "must-not-leak",
      kind: "exec",
      title: "命令审批",
      commandText: "pnpm test",
      metadata: [],
      actions: [],
      expiresAtMs: Date.now() + 60_000,
      deviceId: "",
      ts: Date.now(),
    });
    dispatchGatewayMethod.mockImplementation(async (method: string) => {
      if (method === "exec.approval.list") throw new Error("gateway disconnected");
      if (method === "plugin.approval.list" || method === "openclaw.approval.list") {
        return { ok: true, payload: [] };
      }
      if (method === "cron.list") return { ok: true, payload: { jobs: [], total: 0 } };
      if (method === "cron.status") return { ok: true, payload: { enabled: true } };
      if (method === "models.authStatus") return { ok: true, payload: { providers: [] } };
      if (method === "update.status") return { ok: true, payload: { sentinel: null } };
      throw new Error(`unexpected method ${method}`);
    });

    const result = await invoke(
      "GET",
      "/friday-next-admin/inbox/snapshot?deviceId=phone-a&afterCursor=0",
    );

    expect(result.json).toMatchObject({
      attention: { approvals: [] },
      sources: { execApprovals: { status: "stale", detail: "gateway disconnected" } },
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

  it("兼容 2026.7.1：原生 resolve 方法不存在时使用统一 SDK resolver", async () => {
    legacyApprovalStore.upsert({
      op: "request",
      approvalId: "legacy-exec-1",
      kind: "exec",
      title: "命令审批",
      commandText: "pnpm test",
      metadata: [],
      actions: [],
      expiresAtMs: Date.now() + 60_000,
      deviceId: "",
      ts: Date.now(),
    });
    dispatchGatewayMethod.mockResolvedValue({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "unknown method: exec.approval.resolve",
      },
    });

    const result = await invoke("POST", "/friday-next-admin/inbox/approvals/resolve", {
      approvalId: "legacy-exec-1",
      kind: "exec",
      decision: "allow-once",
    });

    expect(result.status).toBe(200);
    expect(resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "legacy-exec-1",
        decision: "allow-once",
        allowPluginFallback: true,
      }),
    );
    expect(legacyApprovalStore.list("exec")).toEqual([]);
  });
});
