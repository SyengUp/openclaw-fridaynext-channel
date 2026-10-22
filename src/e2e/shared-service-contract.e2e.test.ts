import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createContractHarness } from "@syengup/fridaynext-channel-kit/testing/contract-harness";
import { getOpenClawChannelService } from "../adapters/openclaw/channel-service.js";
import { mappedNativeSessionKey } from "../adapters/openclaw/session-metadata.js";
import {
  createTempHistoryDir,
  removeTempHistoryDir,
  setMockRuntime,
} from "../test-support/mock-runtime.js";
import { mockDispatchScript, resetMockDispatch } from "../test-support/mock-dispatch.js";

describe("OpenClaw 接入公共完整服务的真实 HTTP 合同", () => {
  let root = "";
  afterEach(() => {
    resetMockDispatch();
    if (root) removeTempHistoryDir(root);
  });

  it("同一服务入口提供现代/旧版准入、规范回放、目录身份及公共资源", async () => {
    root = createTempHistoryDir();
    setMockRuntime({
      historyDir: path.join(root, "history"),
      authToken: "contract-token",
      publicAccessEnabled: false,
    });
    const service = getOpenClawChannelService();
    const dispatch = mockDispatchScript()
      .lifecycle("start")
      .partial("共享链路🙂")
      .deliverFinal({ text: "共享链路🙂" })
      .lifecycle("end")
      .install();
    const f = await createContractHarness({
      adapter: service.runner.adapter,
      service,
      dataDir: root,
      authToken: "contract-token",
    });
    try {
      const logical = randomUUID() + "/AbC";
      const command = {
        deviceId: "PHONE",
        sessionKey: logical,
        agentId: "main",
        clientRequestId: "stable",
        text: "任务",
      };
      const accepted = await f.request("/friday-next/v3/messages", {
        method: "POST",
        body: command,
      });
      expect(accepted.status).toBe(202);
      await vi.waitFor(() =>
        expect(service.store.run(String(accepted.body.runId))?.phase).toBe("completed"),
      );
      const old = await f.request("/friday-next/messages", {
        method: "POST",
        canonical: false,
        body: command,
      });
      expect(old.body.runId).toBe(accepted.body.runId);
      expect(old.body.replayed).toBe(true);
      expect(dispatch.calls).toHaveLength(1);
      const conflict = await f.request("/friday-next/v3/messages", {
        method: "POST",
        body: { ...command, agentId: "other", clientRequestId: "conflict" },
      });
      expect(conflict.status).toBe(409);
      expect(service.store.runs()).toHaveLength(1);
      expect(mappedNativeSessionKey(logical)).toBe(
        service.store.run(String(accepted.body.runId))?.sessionKey,
      );
      const events = await f.request("/friday-next/v3/sync?deviceId=PHONE");
      expect(JSON.stringify(events.body)).toContain("共享链路🙂");
      expect(JSON.stringify(events.body)).not.toContain("_sourceEvent");
      const legacy = await f.request("/friday-next/v3/sync?deviceId=PHONE", { canonical: false });
      expect(JSON.stringify(legacy.body)).toContain("_sourceEventData");
      const health = await f.request("/friday-next/health");
      expect(health.body.backend).toMatchObject({ id: "openclaw" });
      expect(health.body.gatewayFingerprint).toBeTruthy();
      expect(
        (
          await f.request("/friday-next/server-name", {
            method: "PUT",
            body: { name: "OpenClaw 合同后端" },
          })
        ).body.name,
      ).toBe("OpenClaw 合同后端");
      expect((await f.request("/friday-next/prompt-capsules")).body.storeId).toBe(
        health.body.gatewayFingerprint,
      );
      expect(getOpenClawChannelService()).toBe(service);
    } finally {
      await f.close();
    }
  });
});
