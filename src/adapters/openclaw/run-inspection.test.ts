import { describe, expect, it, vi } from "vitest";
import type { DurableRunRecord } from "@syengup/fridaynext-channel-kit";
vi.mock("../../history/read-transcript.js", () => ({
  readSessionTranscriptRawMessages: () => [
    { role: "user", idempotencyKey: "request", content: "任务" },
    { role: "assistant", content: [{ type: "text", text: "已有部分回答" }] },
  ],
}));
import { inspectOpenClawRun } from "./run-inspection.js";
import { OpenClawBackendAdapter } from "./backend-adapter.js";

const run = {
  runId: "run",
  clientRequestId: "request",
  sessionKey: "agent:main:task",
  createdAt: 1,
} as DurableRunRecord;

describe("宿主权威运行状态", () => {
  it("精确请求关联的助手消息仍不能证明宿主运行结束", async () => {
    expect(await inspectOpenClawRun(run, { isRunActive: async () => false })).toEqual({
      state: "unknown",
    });
  });
  it("取消只提交宿主停止请求，不能用历史文本猜作完成", async () => {
    const adapter = new OpenClawBackendAdapter();
    const inspect = vi.spyOn(adapter, "inspect").mockResolvedValue({ state: "completed" });
    expect(await adapter.cancel(run)).toEqual({ state: "unknown" });
    expect(inspect).not.toHaveBeenCalled();
  });
});
