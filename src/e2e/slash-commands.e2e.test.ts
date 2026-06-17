import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppSimulator } from "../test-support/app-simulator.js";
import { mockDispatchScript, resetMockDispatch } from "../test-support/mock-dispatch.js";
import {
  createTempHistoryDir,
  removeTempHistoryDir,
  setMockRuntime,
} from "../test-support/mock-runtime.js";

describe("e2e slash commands", () => {
  let historyDir = "";
  beforeEach(() => {
    historyDir = createTempHistoryDir();
    setMockRuntime({ historyDir, authToken: "test-token" });
    mockDispatchScript().deliverFinal({ text: "ok" }).lifecycle("end").complete().install();
  });
  afterEach(() => {
    resetMockDispatch();
    removeTempHistoryDir(historyDir);
  });

  it("/new /reset 透传为 202", async () => {
    const app = createAppSimulator({ token: "test-token" });
    const a = await app.sendMessage({ text: "/new", sessionKey: "sk1" });
    expect(a.status).toBe(202);
    const b = await app.sendMessage({ text: "/reset", sessionKey: "sk1" });
    expect(b.status).toBe(202);
  });

  it("/stop 与非法斜杠路径可接受", async () => {
    const app = createAppSimulator({ token: "test-token" });
    const stop = await app.sendMessage({ text: "/stop", sessionKey: "sk2" });
    expect(stop.status).toBe(202);
    const illegal = await app.sendMessage({ text: "/???", sessionKey: "sk2" });
    expect(illegal.status).toBe(202);
  });
});
