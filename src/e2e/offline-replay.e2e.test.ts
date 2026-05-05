import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppSimulator } from "../test-support/app-simulator.js";
import { mockDispatchScript, resetMockDispatch } from "../test-support/mock-dispatch.js";
import { createTempHistoryDir, removeTempHistoryDir, setMockRuntime } from "../test-support/mock-runtime.js";

describe("e2e offline SSE replay", () => {
  let historyDir = "";

  beforeEach(() => {
    historyDir = createTempHistoryDir();
    setMockRuntime({ historyDir, authToken: "test-token", sseBacklogPerDevice: 50 });
  });

  afterEach(() => {
    resetMockDispatch();
    removeTempHistoryDir(historyDir);
  });

  it("断开后产生的事件在 Last-Event-ID 重连后回放", async () => {
    mockDispatchScript().lifecycle("start").partial("x").deliverFinal({ text: "x" }).lifecycle("end").install();

    const app = createAppSimulator({ token: "test-token", deviceId: "replay-dev" });
    await app.connectSSE({ deviceId: "replay-dev" });
    await app.sendMessage({ text: "first", sessionKey: "r1", deviceId: "replay-dev" });
    await app.waitForSse((f) => f.some((x) => x.event === "deliver"));
    const framesA = app.getSseFrames();
    const maxId = Math.max(...framesA.map((x) => x.id ?? 0));
    app.disconnectSSE();

    resetMockDispatch();
    mockDispatchScript().lifecycle("start").partial("y").deliverFinal({ text: "y" }).lifecycle("end").install();
    await app.sendMessage({ text: "again", sessionKey: "r1", deviceId: "replay-dev" });
    await new Promise((r) => setTimeout(r, 80));

    await app.connectSSE({ deviceId: "replay-dev", lastEventId: maxId });
    const framesB = await app.waitForSse(
      (f) => f.some((x) => (x.id ?? 0) > maxId && x.event === "deliver"),
      3000,
    );
    expect(framesB.some((x) => (x.id ?? 0) > maxId)).toBe(true);
    app.disconnectSSE();
  });
});
