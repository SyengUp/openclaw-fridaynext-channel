import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppSimulator } from "../test-support/app-simulator.js";
import { mockDispatchScript, resetMockDispatch } from "../test-support/mock-dispatch.js";
import {
  createTempHistoryDir,
  removeTempHistoryDir,
  setMockRuntime,
} from "../test-support/mock-runtime.js";

describe("e2e attachments inbound", () => {
  let historyDir = "";
  beforeEach(() => {
    historyDir = createTempHistoryDir();
    setMockRuntime({ historyDir, authToken: "test-token" });
    mockDispatchScript().deliverFinal({ text: "ok" }).install();
  });
  afterEach(() => {
    resetMockDispatch();
    removeTempHistoryDir(historyDir);
  });

  it("multipart 上传 + 下载 + range", async () => {
    const app = createAppSimulator({ token: "test-token" });
    const up = await app.uploadFiles([
      { name: "file", filename: "a.txt", contentType: "text/plain", content: "hello world" },
    ]);
    expect(up.status).toBe(200);
    const url = String(up.body.files?.[0]?.url ?? "");
    expect(url.startsWith("/friday-next/files/")).toBe(true);

    const full = await app.downloadFile(url);
    expect(full.status).toBe(200);
    expect(full.body.toString("utf-8")).toBe("hello world");

    const ranged = await app.downloadFile(url, { range: "bytes=0-4" });
    expect(ranged.status).toBe(206);
    expect(ranged.body.toString("utf-8")).toBe("hello");
  });

  it("空上传与非法编码报错", async () => {
    const app = createAppSimulator({ token: "test-token" });
    const empty = await app.uploadFiles([]);
    expect(empty.status).toBe(400);
    const bad = await app.downloadFile("/friday-next/files/%");
    expect(bad.status).toBe(400);
  });
});
