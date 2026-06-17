import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppSimulator } from "../test-support/app-simulator.js";
import {
  createTempHistoryDir,
  removeTempHistoryDir,
  setMockRuntime,
} from "../test-support/mock-runtime.js";

describe("e2e connect and connected", () => {
  let historyDir = "";

  beforeEach(() => {
    historyDir = createTempHistoryDir();
    setMockRuntime({ historyDir, authToken: "test-token" });
  });

  afterEach(() => {
    removeTempHistoryDir(historyDir);
  });

  it("无 Bearer 返回 401", async () => {
    const app = createAppSimulator({ token: "" });
    const res = await app.rawRequest({
      method: "GET",
      path: "/friday-next/events?deviceId=dev-a",
      headers: {},
    });
    expect(res.status).toBe(401);
    expect(res.body).toContain("Unauthorized");
  });

  it("正确 Bearer 返回 SSE 头与 connected 首帧", async () => {
    const app = createAppSimulator({ token: "test-token" });
    const sseRes = await app.connectSSE({ deviceId: "dev-a" });
    expect(sseRes.statusCode).toBe(200);
    expect(sseRes.getHeader("content-type")).toContain("text/event-stream");
    expect(sseRes.getHeader("x-accel-buffering")).toBe("no");
    expect(sseRes.getHeader("cache-control")).toContain("no-cache");

    const frames = await app.waitForSse((f) => f.some((x) => x.event === "connected"));
    const connected = frames.find((x) => x.event === "connected");
    expect(connected).toBeTruthy();
    expect(connected?.data?.deviceId).toBe("DEV-A");
    expect(typeof connected?.data?.lastSeq).toBe("number");
    expect(typeof connected?.data?.serverTime).toBe("number");
    app.disconnectSSE();
  });
});
