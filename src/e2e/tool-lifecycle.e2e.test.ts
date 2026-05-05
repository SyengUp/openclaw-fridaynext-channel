import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppSimulator } from "../test-support/app-simulator.js";
import { mockDispatchScript, resetMockDispatch } from "../test-support/mock-dispatch.js";
import { createTempHistoryDir, removeTempHistoryDir, setMockRuntime } from "../test-support/mock-runtime.js";

describe("e2e tool lifecycle", () => {
  let historyDir = "";
  beforeEach(() => {
    historyDir = createTempHistoryDir();
    setMockRuntime({ historyDir, authToken: "test-token" });
  });
  afterEach(() => {
    resetMockDispatch();
    removeTempHistoryDir(historyDir);
  });

  it("agent tool 流 + deliver 可达", async () => {
    mockDispatchScript()
      .lifecycle("start")
      .toolStart(
        "browser",
        { action: "goto", url: "https://a.com" },
        { meta: "navigate url=https://a.com", displayEmoji: "🌐", displayLabel: "Browser" },
      )
      .toolEnd("browser", { ok: true })
      .toolError("exec", { message: "failed" })
      .deliverFinal({ text: "done" })
      .lifecycle("end")
      .install();
    const app = createAppSimulator({ token: "test-token" });
    await app.connectSSE();
    await app.sendMessage({ text: "run tools", sessionKey: "tool-sk" });
    const frames = await app.waitForSse((f) => f.some((x) => x.event === "deliver"));
    const agents = frames.filter((x) => x.event === "agent");
    expect(agents.some((x) => (x.data?.stream as string) === "tool")).toBe(true);
    const toolStart = agents.find(
      (x) =>
        (x.data?.stream as string) === "tool" &&
        (x.data?.data as Record<string, unknown> | undefined)?.phase === "start",
    );
    const toolStartData = toolStart?.data?.data as Record<string, unknown> | undefined;
    expect(toolStartData?.args).toEqual({ action: "goto", url: "https://a.com" });
    expect(toolStartData?.meta).toBe("navigate url=https://a.com");
    expect(toolStartData?.displayEmoji).toBe("🌐");
    expect(toolStartData?.displayLabel).toBe("Browser");
    expect(frames.some((x) => x.event === "deliver")).toBe(true);
    app.disconnectSSE();
  });
});
