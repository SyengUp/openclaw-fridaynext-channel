import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalHistory } from "../adapters/openclaw/history-projection.js";
import { HISTORY_TEXT_MAX_CHARS, normalizeHistoryMessage } from "./normalize-message.js";

const fixture = JSON.parse(fs.readFileSync(
  new URL("./fixtures/file-context-device-turn-2026-10-21.json", import.meta.url), "utf8",
)) as {
  clientRequestId: string;
  runId: string;
  prompt: string;
  userMessage: {
    role: string;
    content: string;
    __openclaw: { id: string; seq: number; transport: { channel: string; messageId: string }; media: unknown[] };
  };
};
const fileBlock = fixture.userMessage.content.slice(fixture.userMessage.content.indexOf("<file "));

describe("用户附件的宿主提取正文", () => {
  it.each([false, true])("真实设备记录在 fullText=%s 时只展示原提示，保留两个附件", fullText => {
    const row = normalizeHistoryMessage(fixture.userMessage, 0, { fullText })!;
    expect(row.text?.length).toBe(fixture.prompt.length);
    expect(row.text).toBe(fixture.prompt);
    expect(row.images).toHaveLength(2);
    expect(row.id).toBe(fixture.userMessage.__openclaw.id);
    expect(row.clientRequestId).toBe(fixture.clientRequestId);
  });

  it("已有明确频道请求时，用户自己输入的相同 file 标签仍完整保留", () => {
    const authored = `请解释以下格式，不要隐藏它：\n\n${fileBlock}`;
    const source = { ...fixture.userMessage, content: `${authored}\n\n${fileBlock}` };
    const row = normalizeHistoryMessage(source, 0)!;
    const projected = canonicalHistory([row], new Set([fixture.clientRequestId]),
      new Map([[fixture.runId, fixture.clientRequestId]]), { userTextByRequest: new Map([[fixture.clientRequestId, authored]]) });
    expect(projected[0].text?.length).toBe(authored.length);
    expect(projected[0].text).toBe(authored);
    expect(projected[0].images).toBeUndefined();
  });

  it("原提示的长文本仍遵守历史页预算，只有全文详情返回完整正文", () => {
    const original = "用户正文".repeat(HISTORY_TEXT_MAX_CHARS);
    const row = normalizeHistoryMessage(fixture.userMessage, 0)!;
    const userTextByRequest = new Map([[fixture.clientRequestId, original]]);
    const owned = new Set([fixture.clientRequestId]);
    expect(canonicalHistory([row], owned, new Map(), { userTextByRequest })[0])
      .toMatchObject({ text: original.slice(0, HISTORY_TEXT_MAX_CHARS), truncated: true });
    expect(canonicalHistory([row], owned, new Map(), { userTextByRequest, fullText: true })[0].text).toBe(original);
  });

  it("不移除没有宿主媒体事实的用户文本", () => {
    const authored = `这段是我输入的文本\n\n${fileBlock}`;
    expect(normalizeHistoryMessage({ role: "user", content: authored }, 0)?.text).toBe(authored);
  });

  it("先移除超过历史预算的附件内容，用户提示不会被截断标志污染", () => {
    const longBlock = fileBlock.replace("</file>", `${"附件内容".repeat(HISTORY_TEXT_MAX_CHARS)}\n</file>`);
    const row = normalizeHistoryMessage({ ...fixture.userMessage, content: `${fixture.prompt}\n\n${longBlock}` }, 0)!;
    expect(row.text).toBe(fixture.prompt);
    expect(row.truncated).toBeUndefined();
  });

  it("可移除多个带 XML 转义文件名的末尾提取块", () => {
    const text = `${fixture.prompt}\n\n<file name="a&amp;b.txt" mime="text/plain">\n附件一\n</file>\n\n<file name="second.txt" mime="text/plain">\n附件二\n</file>`;
    const media = ["a&b.txt", "second.txt"].map(fileName => ({ kind: "document", contentType: "text/plain", fileName }));
    expect(normalizeHistoryMessage({ ...fixture.userMessage, content: text,
      __openclaw: { ...fixture.userMessage.__openclaw, media } }, 0)?.text).toBe(fixture.prompt);
  });

  it("不移除文件名或 MIME 不匹配、未闭合的文本，也不处理助手正文", () => {
    for (const media of [
      [{ fileName: "different.md", contentType: "text/markdown", kind: "document" }],
      [{ fileName: "FR154_TOOL_DISCOVERY_QUERY_LIMIT.md", contentType: "application/pdf", kind: "document" }],
    ]) {
      const row = normalizeHistoryMessage({ ...fixture.userMessage, content: fileBlock,
        __openclaw: { ...fixture.userMessage.__openclaw, media } }, 0)!;
      expect(row.text).toBe(fileBlock);
    }
    const partial = fileBlock.replace("</file>", "");
    expect(normalizeHistoryMessage({ ...fixture.userMessage, content: partial }, 0)?.text).toBe(partial.trim());
    expect(normalizeHistoryMessage({ ...fixture.userMessage, role: "assistant", content: fileBlock }, 0)?.text).toBe(fileBlock);
  });
});
