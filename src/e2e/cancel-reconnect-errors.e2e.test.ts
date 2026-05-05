import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppSimulator } from "../test-support/app-simulator.js";
import { mockDispatchScript, resetMockDispatch } from "../test-support/mock-dispatch.js";
import { createTempHistoryDir, removeTempHistoryDir, setMockRuntime } from "../test-support/mock-runtime.js";

describe("e2e cancel reconnect errors", () => {
  let historyDir = "";
  beforeEach(() => {
    historyDir = createTempHistoryDir();
    setMockRuntime({ historyDir, authToken: "test-token", sseBacklogPerDevice: 20 });
  });
  afterEach(() => {
    resetMockDispatch();
    removeTempHistoryDir(historyDir);
  });

  it("cancel 缺 runId 与 200 cancel", async () => {
    mockDispatchScript().lifecycle("start").partial("a").deliverFinal({ text: "a" }).lifecycle("end").install();
    const app = createAppSimulator({ token: "test-token" });
    await app.connectSSE();
    const sent = await app.sendMessage({ text: "go", sessionKey: "c1" });
    const runId = String(sent.body.runId ?? "");
    expect(runId.length).toBeGreaterThan(0);
    await app.waitForSse((f) => f.some((x) => x.event === "deliver"));
    const bad = await app.rawRequest({
      method: "POST",
      path: "/friday-next/cancel",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(bad.status).toBe(400);
    const ok = await app.cancel(runId);
    expect(ok.status).toBe(200);
    app.disconnectSSE();
  });

  it("Last-Event-ID replay 与多 device 隔离", async () => {
    mockDispatchScript().lifecycle("start").partial("h").partial("hi").deliverFinal({ text: "hi" }).lifecycle("end").install();
    const appA = createAppSimulator({ token: "test-token", deviceId: "A" });
    await appA.connectSSE();
    await appA.sendMessage({ text: "one", sessionKey: "r1" });
    const framesA = await appA.waitForSse((f) => f.some((x) => x.event === "deliver"));
    const maxId = Math.max(...framesA.map((x) => x.id ?? 0));
    appA.disconnectSSE();
    await appA.connectSSE({ deviceId: "A", lastEventId: Math.max(1, maxId - 1) });
    const replayed = appA.getSseFrames().filter((x) => (x.id ?? 0) > Math.max(1, maxId - 1));
    expect(replayed.length).toBeGreaterThan(0);

    const appB = createAppSimulator({ token: "test-token", deviceId: "B" });
    await appB.connectSSE();
    const framesB = appB.getSseFrames();
    expect(framesB[0]?.id).toBe(1);
    appA.disconnectSSE();
    appB.disconnectSSE();
  });
});
