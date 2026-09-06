import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sseEmitter } from "../sse/emitter.js";
import {
  createTempHistoryDir,
  removeTempHistoryDir,
  setMockRuntime,
} from "../test-support/mock-runtime.js";
import { getRuntimeV3Store } from "../runtime-v3/runtime-store.js";
import { createSendFileTool, SEND_FILE_TOOL_NAME } from "./send-file-tool.js";

vi.mock("../friday-session.js", () => ({
  resolveFridayDeviceIdForSessionKey: () => "PHONE-1",
  getLastRegisteredFridayDeviceId: () => "PHONE-1",
}));

describe("createSendFileTool", () => {
  let historyDir = "";

  beforeEach(() => {
    historyDir = createTempHistoryDir();
    setMockRuntime({ historyDir });
  });

  afterEach(() => {
    sseEmitter.resetForTest();
    removeTempHistoryDir(historyDir);
  });

  it("advertises the in-session attachment path instead of the external message CLI", () => {
    const tool = createSendFileTool({ sessionKey: "agent:main:s1" });
    expect(tool.name).toBe(SEND_FILE_TOOL_NAME);
    expect(tool.description).toContain("local file");
    expect(tool.description).toContain("openclaw message send");
  });

  it("durably delivers a local file through the active protocol-v3 run while the app is offline", async () => {
    const store = getRuntimeV3Store();
    const accepted = store.acceptCommand({
      clientRequestId: "cr-file-1",
      deviceId: "PHONE-1",
      sessionKey: "agent:main:s1",
      agentId: "main",
      text: "send the desktop png",
      attachments: [],
    });
    expect(accepted.outcome).toBe("accepted");
    store.transition(accepted.run!.runId, "running");

    const mediaPath = path.join(historyDir, "Frame 33.png");
    fs.writeFileSync(mediaPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const tool = createSendFileTool({ sessionKey: "agent:main:s1" });
    const result = await tool.execute("call-file-1", { path: mediaPath });
    const parsed = JSON.parse(result.content[0].text) as {
      ok: boolean;
      filename: string;
    };

    expect(parsed).toMatchObject({ ok: true, filename: "Frame 33.png" });
    const outbound = store
      .eventsForRun(accepted.run!.runId)
      .find((event) => event.eventType === "outbound.media");
    expect(outbound).toBeDefined();
    expect(outbound?.payload._sourceEventType).toBe("outbound");
    expect(outbound?.payload._sourceEventData).toMatchObject({
      op: "media",
      runId: accepted.run!.runId,
      sessionKey: "agent:main:s1",
      deviceId: "PHONE-1",
    });
    expect(
      String((outbound?.payload._sourceEventData as Record<string, unknown>)?.mediaUrl),
    ).toMatch(/^\/friday-next\/files\/.+\.png$/);
  });
});
