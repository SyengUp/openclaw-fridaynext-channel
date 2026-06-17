import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppSimulator } from "../test-support/app-simulator.js";
import {
  createTempHistoryDir,
  removeTempHistoryDir,
  setMockRuntime,
} from "../test-support/mock-runtime.js";
import { registerFridayNextHttpRoutes } from "../http/server.js";

describe("e2e status cors auth", () => {
  let historyDir = "";
  beforeEach(() => {
    historyDir = createTempHistoryDir();
  });
  afterEach(() => {
    removeTempHistoryDir(historyDir);
  });

  it("status 返回标准字段", async () => {
    setMockRuntime({ historyDir, authToken: "test-token" });
    const app = createAppSimulator({ token: "test-token" });
    const status = await app.status();
    expect(status.status).toBe(200);
    expect(status.body.channel).toBe("friday-next");
    expect(status.body.version).toBe("v2");
  });

  it("CORS 预检", async () => {
    setMockRuntime({
      historyDir,
      authToken: "test-token",
      corsEnabled: true,
      allowOrigin: "https://app.example",
    });
    const app = createAppSimulator({ token: "test-token" });
    const res = await app.options("/friday-next/events", "https://app.example");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example");
  });

  it("authToken 为空时警告", () => {
    setMockRuntime({ historyDir, authToken: "" });
    const warn = vi.fn();
    registerFridayNextHttpRoutes({
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
      registerHttpRoute: vi.fn(),
    } as never);
    expect(warn).toHaveBeenCalled();
  });
});
