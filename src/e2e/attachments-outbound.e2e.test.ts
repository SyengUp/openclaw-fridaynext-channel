import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppSimulator } from "../test-support/app-simulator.js";
import { mockDispatchScript, resetMockDispatch } from "../test-support/mock-dispatch.js";
import {
  createTempHistoryDir,
  removeTempHistoryDir,
  setMockRuntime,
} from "../test-support/mock-runtime.js";

describe("e2e attachments outbound", () => {
  let historyDir = "";
  let mediaFile = "";

  beforeEach(() => {
    historyDir = createTempHistoryDir();
    mediaFile = path.join(historyDir, "voice.mp3");
    fs.writeFileSync(mediaFile, "audio-bytes");
    setMockRuntime({ historyDir, authToken: "test-token" });
  });

  afterEach(() => {
    resetMockDispatch();
    removeTempHistoryDir(historyDir);
  });

  it("block/final deliver 含可解析的媒体 URL", async () => {
    mockDispatchScript()
      .lifecycle("start")
      .block("one", [mediaFile], true)
      .deliverFinal({ text: "done", mediaUrls: [mediaFile], audioAsVoice: true })
      .lifecycle("end")
      .install();

    const app = createAppSimulator({ token: "test-token" });
    await app.connectSSE();
    await app.sendMessage({ text: "play", sessionKey: "s1" });
    const frames = await app.waitForSse((f) => f.filter((x) => x.event === "deliver").length >= 2);

    const delivers = frames.filter((x) => x.event === "deliver");
    expect(delivers.length).toBeGreaterThanOrEqual(1);
    const urls =
      (delivers[delivers.length - 1]?.data?.payload as { mediaUrls?: string[] })?.mediaUrls ?? [];
    expect(urls.some((u) => u.includes("/friday-next/files/"))).toBe(true);
    app.disconnectSSE();
  });
});
