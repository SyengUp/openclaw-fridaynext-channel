import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleHistoryMessageDetail, handleHistoryMessages } from "./history-messages.js";
import { readOpenClawSnapshot } from "../../adapters/openclaw/transport-compatibility.js";
import { resetFridayAgentForwardRuntimeForTest, setFridayAgentForwardRuntime } from "../../agent-forward-runtime.js";
import { getRuntimeV3Store } from "../../runtime-v3/runtime-store.js";
import { removeTempHistoryDir, setMockRuntime } from "../../test-support/mock-runtime.js";
import type { FridayHistoryMessage } from "../../history/normalize-message.js";

type Sample = { clientRequestId: string; runId: string; originalId: string; noticeId: string; rawMessages: Record<string, unknown>[] };
const samples = JSON.parse(fs.readFileSync(new URL("../../history/fixtures/standalone-workshop-notices-2026-10-22.json", import.meta.url), "utf8")) as Sample[];

describe("独立消息的生产历史入口与旧客户端兼容", () => {
  let root: string;
  afterEach(() => { resetFridayAgentForwardRuntimeForTest(); removeTempHistoryDir(root); });

  for (const [index, sample] of samples.entries()) {
    it(`真实样本 ${index + 1} 的列表、详情、快照保留答案及独立通知`, async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-standalone-history-"));
      const key = "agent:main:standalone-history";
      setMockRuntime({ historyDir: path.join(root, "history"), authToken: "test-token" });
      const store = getRuntimeV3Store();
      const run = store.acceptCommand({ clientRequestId: sample.clientRequestId, deviceId: "PHONE", sessionKey: key, agentId: "main", text: "User request", attachments: [] }).run!;
      store.transition(run.runId, "completed");
      setFridayAgentForwardRuntime({ runtime: { agent: { session: {
        resolveStorePath: () => path.join(root, "sessions.json"),
        loadSessionStore: () => ({ [key]: { sessionId: "native-fixture", sessionFile: "sqlite:native-fixture" } }),
        loadTranscriptEventsSync: () => sample.rawMessages.map((raw, offset) => ({
          type: "message", id: (raw.__openclaw as { id: string }).id,
          timestamp: new Date(1_000 + offset * 1_000).toISOString(),
          message: { ...raw, __openclaw: { ...(raw.__openclaw as object), runId: run.runId } },
        })),
      } } } } as never);

      async function read(canonical: boolean, detail = false) {
        const response = { statusCode: 0, body: "", setHeader() {}, end(value: string) { this.body = value; } };
        const headers = { authorization: "Bearer test-token", ...(canonical ? { "x-fridaynext-event-format": "canonical-v1" } : {}) };
        const req = { method: "GET", headers, url: detail
          ? `/friday-next/history/message-detail?sessionKey=${key}&id=${sample.noticeId}`
          : `/friday-next/history/messages?sessionKey=${key}` };
        await (detail ? handleHistoryMessageDetail : handleHistoryMessages)(req as never, response as never);
        expect(response.statusCode).toBe(200);
        return JSON.parse(response.body) as { message: FridayHistoryMessage; messages: FridayHistoryMessage[] };
      }

      const page = (await read(true)).messages;
      const snapshot = await readOpenClawSnapshot(key, 100);
      for (const rows of [page, snapshot.transcript as unknown as FridayHistoryMessage[]]) {
        expect(rows.find(row => row.id === sample.originalId)?.text).toBe(`Original answer ${index + 1}`);
        const notice = rows.find(row => row.id === sample.noticeId)!;
        expect(notice.kind).toBe("standalone");
        expect(notice.runId).toBeUndefined();
        expect(notice.clientRequestId).toBeUndefined();
        expect(rows.some(row => row.id.startsWith("standalone-boundary:"))).toBe(false);
      }
      const detail = (await read(true, true)).message;
      expect(detail.kind).toBe("standalone");
      expect(detail.runId).toBeUndefined();
      expect(detail.clientRequestId).toBeUndefined();

      // 旧 App 只认识回合边界，不认识 standalone；兼容输出须确保原正文不被 last-wins 覆盖。
      const legacy = (await read(false)).messages;
      const position = legacy.findIndex(row => row.id === sample.noticeId);
      expect(legacy[position - 1]?.kind).toBe("turnBoundary");
      expect(legacy[position + 1]?.kind).toBe("turnBoundary");
      expect(legacy[position - 1]?.seq).toBe(legacy[position].seq);
      const bodies: string[] = [];
      let body = "";
      for (const row of legacy.toSorted((a, b) => a.seq - b.seq)) {
        if (row.role === "user" || row.kind === "turnBoundary") {
          if (body) bodies.push(body);
          body = "";
        } else if (row.role === "assistant" && row.text) body = row.text;
      }
      if (body) bodies.push(body);
      expect(bodies).toContain(`Original answer ${index + 1}`);
      expect(bodies).toContain(`Background update ${index + 1}`);
    });
  }
});
