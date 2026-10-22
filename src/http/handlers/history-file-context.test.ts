import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleHistoryMessageDetail, handleHistoryMessages, historyUserTexts } from "./history-messages.js";
import { readOpenClawSnapshot } from "../../adapters/openclaw/transport-compatibility.js";
import { resetFridayAgentForwardRuntimeForTest, setFridayAgentForwardRuntime } from "../../agent-forward-runtime.js";
import { getRuntimeV3Store } from "../../runtime-v3/runtime-store.js";
import { removeTempHistoryDir, setMockRuntime } from "../../test-support/mock-runtime.js";

const fixture = JSON.parse(fs.readFileSync(
  new URL("../../history/fixtures/file-context-device-turn-2026-10-21.json", import.meta.url), "utf8",
)) as { clientRequestId: string; prompt: string; userMessage: { content: string; __openclaw: { id: string } } };
const key = "agent:main:attachment-display";
const fileBlock = fixture.userMessage.content.slice(fixture.userMessage.content.indexOf("<file "));
const authored = `用户自己输入的标签必须保留\n\n${fileBlock}`;

describe("文件正文的生产历史读取入口", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-file-display-"));
    setMockRuntime({ historyDir: path.join(root, "history"), authToken: "test-token" });
    const command = getRuntimeV3Store().acceptCommand({ clientRequestId: fixture.clientRequestId,
      deviceId: "PHONE", sessionKey: key, agentId: "main", text: authored, attachments: ["image", "document"] }).run!;
    getRuntimeV3Store().transition(command.runId, "completed");
    setFridayAgentForwardRuntime({ runtime: {
      agent: { session: {
        resolveStorePath: () => path.join(root, "sessions.json"),
        loadSessionStore: () => ({ [key]: { sessionId: "native-fixture", sessionFile: "sqlite:native-fixture" } }),
        loadTranscriptEventsSync: () => [{ type: "message", id: fixture.userMessage.__openclaw.id,
          timestamp: "2026-10-21T02:45:00.000Z",
          message: { ...fixture.userMessage, content: `${authored}\n\n${fileBlock}` } }],
      } },
    } } as never);
  });
  afterEach(() => { resetFridayAgentForwardRuntimeForTest(); removeTempHistoryDir(root); });

  it.each(["page", "detail", "snapshot"])("%s 使用原始频道正文，保留作者自己的标签", async entry => {
    let message: { text: string; images?: unknown[]; clientRequestId?: string };
    if (entry === "snapshot") {
      message = (await readOpenClawSnapshot(key, 100)).transcript[0] as typeof message;
    } else {
      const response = { statusCode: 0, body: "", setHeader() {}, end(value: string) { this.body = value; } };
      const headers = { authorization: "Bearer test-token", "x-fridaynext-event-format": "canonical-v1" };
      const req = { method: "GET", headers, url: entry === "page"
        ? `/friday-next/history/messages?sessionKey=${key}`
        : `/friday-next/history/message-detail?sessionKey=${key}&id=${fixture.userMessage.__openclaw.id}` };
      await (entry === "page" ? handleHistoryMessages : handleHistoryMessageDetail)(req as never, response as never);
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { message: typeof message; messages: typeof message[] };
      message = entry === "page" ? body.messages[0] : body.message;
    }
    expect(message.text).toBe(authored);
    expect(message.clientRequestId).toBe(fixture.clientRequestId);
  });

  it("其他会话和没有附件的命令不成为展示正文来源", () => {
    const store = getRuntimeV3Store();
    store.acceptCommand({ clientRequestId: "other-session", deviceId: "PHONE", sessionKey: "agent:main:other",
      agentId: "main", text: "另一会话正文", attachments: ["document"] });
    store.acceptCommand({ clientRequestId: "text-only", deviceId: "PHONE", sessionKey: key,
      agentId: "main", text: "普通正文", attachments: [] });
    for (const deviceId of ["PHONE", "OTHER"]) {
      store.acceptCommand({ clientRequestId: "same-request-across-devices", deviceId, sessionKey: key,
        agentId: "main", text: `来自 ${deviceId}`, attachments: ["document"] });
    }
    expect([...historyUserTexts(key)]).toEqual([[fixture.clientRequestId, authored]]);
    const rows = store.runs();
    const legacy = { ...rows[0], clientRequestId: "legacy-without-attachments", attachments: undefined };
    const read = vi.spyOn(store, "runs").mockReturnValue([...rows, legacy as never]);
    try { expect([...historyUserTexts(key)]).toEqual([[fixture.clientRequestId, authored]]); }
    finally { read.mockRestore(); }
  });
});
