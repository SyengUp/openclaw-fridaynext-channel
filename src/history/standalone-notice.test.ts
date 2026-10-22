import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeHistoryMessage } from "./normalize-message.js";
import { canonicalHistory } from "../adapters/openclaw/history-projection.js";

type CapturedCase = { runId: string; clientRequestId: string; originalId: string; noticeId: string; rawMessages: Record<string, unknown>[] };
// 原生字段、顺序和身份关系来自四条真实回执；正文已去除私人内容。
const captured = JSON.parse(fs.readFileSync(new URL("./fixtures/standalone-workshop-notices-2026-10-22.json", import.meta.url), "utf8")) as CapturedCase[];

describe("后台回执的独立消息归属", () => {
  for (const [index, sample] of captured.entries()) {
    it(`真实样本 ${index + 1} 保留原回答，回执不继承前台请求和运行`, () => {
      const rows = sample.rawMessages.map((raw, position) => normalizeHistoryMessage(raw, position)!);
      const result = canonicalHistory(rows, new Set([sample.clientRequestId]), new Map([[sample.runId, sample.clientRequestId]]));
      const original = result.find(row => row.id === sample.originalId)!;
      const notice = result.find(row => row.id === sample.noticeId)!;
      expect(original.runId).toBe(sample.runId);
      expect(original.clientRequestId).toBe(sample.clientRequestId);
      expect(notice.kind).toBe("standalone");
      expect(notice.runId).toBeUndefined();
      expect(notice.clientRequestId).toBeUndefined();
      expect(notice.text).toBe(`Background update ${index + 1}`);
      expect(notice.id).not.toBe(original.id);
    });
  }

  it("普通回答引用 Learned 文本时仍是正常回答", () => {
    const raw = { role: "assistant", api: "openai-responses", model: "model", content: '💾 Learned: created example. Say "undo" to revert this skill change.', __openclaw: { id: "answer", seq: 1, runId: "R" } };
    const row = normalizeHistoryMessage(raw, 0)!;
    const result = canonicalHistory([row], new Set(["Q"]), new Map([["R", "Q"]]));
    expect(result[0].kind).toBeUndefined();
    expect(result[0].text).toBe(raw.content);
    expect(result[0].clientRequestId).toBe("Q");
  });
});
