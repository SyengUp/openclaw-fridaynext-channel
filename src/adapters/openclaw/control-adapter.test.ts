import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeV3Store, setRuntimeV3RootForTest } from "../../runtime-v3/runtime-store.js";
import {
  createTempHistoryDir,
  removeTempHistoryDir,
  setMockRuntime,
} from "../../test-support/mock-runtime.js";
import { lookupOpenClawControl, openClawControls } from "./control-adapter.js";
import { ensureLogicalSession } from "./session-metadata.js";

const { dispatchGatewayMethod, callGatewayFromCli, submitOpenClawApproval } = vi.hoisted(() => ({
  dispatchGatewayMethod: vi.fn(),
  callGatewayFromCli: vi.fn(),
  submitOpenClawApproval: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({ dispatchGatewayMethod }));
vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({ callGatewayFromCli }));
vi.mock("../../http/handlers/approvals.js", () => ({ submitOpenClawApproval }));

const fixture = JSON.parse(
  fs.readFileSync(new URL("./fixtures/approval-device-2026-10-21.json", import.meta.url), "utf8"),
) as {
  event: { runId: string; payload: Record<string, unknown> };
  approval: {
    id: string;
    status: string;
    presentation: Record<string, unknown>;
    expiresAtMs: number;
  };
};
const id = fixture.approval.id;
const generation = `${fixture.event.runId}:${id}`;
const logical = "58C14A1C-03A8-46EC-8057-BAA2FB066B14";
let root = "";

beforeEach(() => {
  root = createTempHistoryDir();
  setMockRuntime({ historyDir: path.join(root, "history") });
  dispatchGatewayMethod.mockReset();
  callGatewayFromCli.mockReset();
  submitOpenClawApproval.mockReset();
  submitOpenClawApproval.mockResolvedValue({ status: 200, body: { ok: true } });
  // 真实宿主对无审批读取身份的插件请求隐藏记录，而不是报缺少 scope。
  dispatchGatewayMethod.mockResolvedValue({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "approval not found",
      details: { reason: "APPROVAL_NOT_FOUND" },
    },
  });
  callGatewayFromCli.mockResolvedValue({ approval: structuredClone(fixture.approval) });
  const store = getRuntimeV3Store();
  store.observeRun({
    runId: fixture.event.runId,
    sessionKey: ensureLogicalSession(logical, "operator"),
    agentId: "operator",
    deviceIds: ["PHONE"],
  });
  store.appendRunEvent(fixture.event.runId, "approval.request", fixture.event.payload);
});
afterEach(() => {
  setRuntimeV3RootForTest(null);
  removeTempHistoryDir(root);
});

describe("真实审批的权威查询", () => {
  it("普通插件作用域看不到审批时，使用宿主认证的只读查询恢复完整卡片", async () => {
    const control = await lookupOpenClawControl(id);
    expect(control).toMatchObject({
      id,
      kind: "approval",
      status: "pending",
      sessionKey: logical,
      runId: fixture.event.runId,
      generation,
    });
    expect(control?.data?.commandText).toBe(fixture.approval.presentation.commandText);
    expect(control?.options?.map((option) => option.id)).toEqual([
      "allow-once",
      "allow-always",
      "deny",
    ]);
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "approval.get",
      expect.objectContaining({ port: "18789", timeout: "5000", json: true }),
      { id },
      expect.objectContaining({
        progress: false,
        scopes: ["operator.admin"],
        sharedStateMode: "read-only",
      }),
    );
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("ACK 和账本重开不改变审批的会话、运行和控制代际", async () => {
    const store = getRuntimeV3Store();
    store.acknowledge("PHONE", store.eventHead("PHONE"));
    setRuntimeV3RootForTest(path.join(root, "history", "runtime-v3"));
    expect(await lookupOpenClawControl(id)).toMatchObject({
      sessionKey: logical,
      runId: fixture.event.runId,
      generation,
      status: "pending",
    });
  });

  it("权威终态覆盖请求归档，不能留下可操作的旧选项", async () => {
    callGatewayFromCli.mockResolvedValue({
      approval: { ...fixture.approval, status: "allowed", decision: "allow-once" },
    });
    const control = await lookupOpenClawControl(id);
    expect(control).toMatchObject({
      status: "resolved",
      generation,
      data: { decision: "allow-once", actions: [] },
    });
    expect(control?.options).toEqual([]);
  });

  it("只展示宿主当前允许的审批决定", async () => {
    callGatewayFromCli.mockResolvedValue({
      approval: {
        ...fixture.approval,
        presentation: {
          ...fixture.approval.presentation,
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    });
    const control = await lookupOpenClawControl(id);
    expect(control?.options?.map((option) => option.id)).toEqual(["allow-once", "deny"]);
  });

  it.each(["exec", "plugin", "system-agent"])("公共响应保留 %s 宿主归属", async (approvalKind) => {
    callGatewayFromCli.mockResolvedValue({
      approval: {
        ...fixture.approval,
        presentation: { ...fixture.approval.presentation, kind: approvalKind },
      },
    });
    await openClawControls().respondControl(id, {
      commandId: "decision",
      generation,
      answer: { decision: "allow-once" },
    });
    expect(submitOpenClawApproval).toHaveBeenCalledWith(
      id,
      { decision: "allow-once" },
      approvalKind,
    );
  });

  it("拒绝宿主没有声明的永久授权选项", async () => {
    callGatewayFromCli.mockResolvedValue({
      approval: {
        ...fixture.approval,
        presentation: {
          ...fixture.approval.presentation,
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    });
    await expect(
      openClawControls().respondControl(id, {
        commandId: "decision",
        generation,
        answer: { decision: "allow-always" },
      }),
    ).rejects.toThrow("不支持");
    expect(submitOpenClawApproval).not.toHaveBeenCalled();
  });

  it("不存在的请求返回空值，网络或权限故障保留为失败", async () => {
    callGatewayFromCli.mockRejectedValueOnce(
      Object.assign(new Error("approval not found"), { details: { reason: "APPROVAL_NOT_FOUND" } }),
    );
    expect(await lookupOpenClawControl(id)).toBeNull();
    callGatewayFromCli.mockRejectedValueOnce(new Error("missing scope: operator.admin"));
    await expect(lookupOpenClawControl(id)).rejects.toThrow("missing scope");
  });

  it("询问继续使用其原生查询，不复用审批读取权限", async () => {
    dispatchGatewayMethod.mockResolvedValue({
      ok: true,
      payload: {
        question: {
          id: "ask_test",
          runId: "question-run",
          sessionKey: logical,
          status: "pending",
          questions: [],
        },
      },
    });
    expect(await lookupOpenClawControl("ask_test")).toMatchObject({
      id: "ask_test",
      kind: "question",
      runId: "question-run",
      sessionKey: logical,
      generation: "question-run:ask_test",
    });
    expect(dispatchGatewayMethod).toHaveBeenCalledWith("question.get", { id: "ask_test" });
    expect(callGatewayFromCli).not.toHaveBeenCalled();
  });
});
