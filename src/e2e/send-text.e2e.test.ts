import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppSimulator } from "../test-support/app-simulator.js";
import { mockDispatchScript, resetMockDispatch } from "../test-support/mock-dispatch.js";
import {
  createTempHistoryDir,
  removeTempHistoryDir,
  setMockRuntime,
} from "../test-support/mock-runtime.js";

describe("e2e send text", () => {
  let historyDir = "";

  beforeEach(() => {
    historyDir = createTempHistoryDir();
    setMockRuntime({ historyDir, authToken: "test-token" });
  });

  afterEach(() => {
    resetMockDispatch();
    removeTempHistoryDir(historyDir);
  });

  it("202 与 agent + deliver SSE", async () => {
    mockDispatchScript()
      .lifecycle("start")
      .reasoning("think")
      .partial("Hello world")
      .deliverFinal({ text: "Hello world" })
      .lifecycle("end")
      .install();

    const app = createAppSimulator({ token: "test-token", deviceId: "dev-a" });
    await app.connectSSE();
    const sent = await app.sendMessage({ text: "hi", sessionKey: "s1" });
    expect(sent.status).toBe(202);
    expect(sent.body.accepted).toBe(true);
    expect(sent.body.deviceId).toBe("DEV-A");
    expect(typeof sent.body.runId).toBe("string");

    const frames = await app.waitForSse((f) => f.some((x) => x.event === "deliver"));
    const events = frames.map((x) => x.event);
    expect(events).toContain("agent");
    expect(events).toContain("deliver");
    app.disconnectSSE();
  });

  it("assistant 流式事件可达", async () => {
    mockDispatchScript()
      .lifecycle("start")
      .partial("abXdef")
      .deliverFinal({ text: "abXdef" })
      .lifecycle("end")
      .install();
    const app = createAppSimulator({ token: "test-token" });
    await app.connectSSE();
    await app.sendMessage({ text: "hi", sessionKey: "s1" });
    const frames = await app.waitForSse((f) => f.some((x) => x.event === "agent"));
    const agent = frames.filter((x) => x.event === "agent");
    expect(agent.length).toBeGreaterThan(0);
    app.disconnectSSE();
  });

  it("缺少必要字段返回 400", async () => {
    const app = createAppSimulator({ token: "test-token" });
    const badText = await app.sendMessage({ text: "", sessionKey: "s1" });
    expect(badText.status).toBe(400);
    const badDevice = await app.rawRequest({
      method: "POST",
      path: "/friday-next/messages",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", sessionKey: "s1" }),
    });
    expect(badDevice.status).toBe(400);
    const badSession = await app.rawRequest({
      method: "POST",
      path: "/friday-next/messages",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", deviceId: "A" }),
    });
    expect(badSession.status).toBe(400);
  });
});
