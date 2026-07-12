import { describe, it, expect } from "vitest";
import { normalizeHistoryMessage, normalizeHistoryMessages } from "./normalize-message.js";

function meta(id?: string, seq = 1, extra: Record<string, unknown> = {}) {
  return { __openclaw: { ...(id ? { id } : {}), seq, recordTimestampMs: 1700000000000, ...extra } };
}

describe("normalizeHistoryMessage", () => {
  it("returns null for non-object input", () => {
    expect(normalizeHistoryMessage("nope", 0)).toBeNull();
    expect(normalizeHistoryMessage(null, 0)).toBeNull();
    expect(normalizeHistoryMessage([], 0)).toBeNull();
  });

  it("normalizes a string-content user message and carries the stable id + ts", () => {
    const out = normalizeHistoryMessage(
      { role: "user", content: "hello", ...meta("entry-1", 3) },
      7,
    );
    expect(out).toMatchObject({
      id: "entry-1",
      seq: 3,
      ts: 1700000000000,
      role: "user",
      text: "hello",
    });
    expect(out?.synthetic).toBeUndefined();
  });

  it("synthesizes an id and flags synthetic when upstream omits __openclaw.id", () => {
    const out = normalizeHistoryMessage({ role: "user", content: "hi", __openclaw: { seq: 5 } }, 0);
    expect(out?.id).toBe("seq:5");
    expect(out?.synthetic).toBe(true);
  });

  it("falls back to batch index for seq when missing", () => {
    const out = normalizeHistoryMessage({ role: "user", content: "hi" }, 4);
    expect(out?.seq).toBe(5);
    expect(out?.id).toBe("seq:5");
  });

  it("parses assistant text + thinking + toolCall blocks and model/usage", () => {
    const out = normalizeHistoryMessage(
      {
        role: "assistant",
        model: "openai/gpt-4",
        usage: { input: 10, output: 20, totalTokens: 30 },
        content: [
          { type: "thinking", thinking: "let me think" },
          { type: "text", text: "the answer" },
          { type: "toolCall", id: "tc-1", name: "search", arguments: { q: "x" } },
        ],
        ...meta("entry-2", 2),
      },
      0,
    );
    expect(out?.text).toBe("the answer");
    expect(out?.thinking).toBe("let me think");
    expect(out?.toolCalls).toEqual([{ id: "tc-1", name: "search", arguments: { q: "x" } }]);
    expect(out?.model).toBe("openai/gpt-4");
    expect(out?.usage).toEqual({ input: 10, output: 20, totalTokens: 30 });
  });

  it("parses inline image content blocks", () => {
    const out = normalizeHistoryMessage(
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/png", data: "BASE64" },
        ],
        ...meta("entry-img", 1),
      },
      0,
    );
    expect(out?.text).toBe("look");
    expect(out?.images).toEqual([{ mimeType: "image/png", data: "BASE64" }]);
  });

  it("extracts [media attached: ...] markers from text into image urls", () => {
    const out = normalizeHistoryMessage(
      { role: "user", content: "see [media attached: file:///a.jpg]", ...meta("m", 1) },
      0,
    );
    expect(out?.images).toEqual([{ url: "file:///a.jpg" }]);
  });

  it("normalizes a toolResult message", () => {
    const out = normalizeHistoryMessage(
      {
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "search",
        isError: false,
        content: [{ type: "text", text: "result text" }],
        ...meta("entry-tr", 4),
      },
      0,
    );
    expect(out?.role).toBe("toolResult");
    expect(out?.toolResult).toEqual({
      toolCallId: "tc-1",
      toolName: "search",
      text: "result text",
    });
  });

  it("drops base64 image blocks from a canvas snapshot toolResult (agent-only, never a chat attachment)", () => {
    const out = normalizeHistoryMessage(
      {
        role: "toolResult",
        toolCallId: "tc-canvas",
        toolName: "canvas",
        content: [{ type: "image", mimeType: "image/jpeg", data: "BASE64SNAPSHOT" }],
        ...meta("entry-canvas", 5),
      },
      0,
    );
    expect(out?.role).toBe("toolResult");
    expect(out?.toolResult).toEqual({ toolCallId: "tc-canvas", toolName: "canvas" });
    expect(out?.toolResult?.images).toBeUndefined();
  });

  it("keeps image blocks on image-producing (image_generation) toolResults", () => {
    const out = normalizeHistoryMessage(
      {
        role: "toolResult",
        toolCallId: "tc-img",
        toolName: "image_generation",
        content: [{ type: "image", mimeType: "image/png", data: "REALIMG" }],
        ...meta("entry-img", 6),
      },
      0,
    );
    expect(out?.toolResult?.images).toEqual([{ mimeType: "image/png", data: "REALIMG" }]);
  });

  it("drops inline image blocks on read toolResults (agent visual input, not an attachment)", () => {
    // The `read` tool returns the file it fed to the model as an inline base64
    // image so the agent can "see" it. That is NOT a user-facing attachment —
    // surfacing it spawned phantom corrupt image bubbles on history rebuild for
    // turns where the agent only LOOKED at a file and sent nothing.
    const out = normalizeHistoryMessage(
      {
        role: "toolResult",
        toolCallId: "tc-read",
        toolName: "read",
        content: [
          { type: "text", text: "Read image file [image/jpeg]" },
          { type: "image", mimeType: "image/jpeg", data: "AGENTVISUALINPUT" },
        ],
        ...meta("entry-read", 7),
      },
      0,
    );
    expect(out?.toolResult?.images).toBeUndefined();
    expect(out?.toolResult?.text).toBe("Read image file [image/jpeg]");
  });

  it("strips MEDIA: lines from text into mediaPaths", () => {
    const out = normalizeHistoryMessage(
      {
        role: "assistant",
        content:
          "Here is the serene landscape 🌅\nMEDIA:/Users/me/.openclaw/media/tool-image-generation/x.png",
        ...meta("a1", 1),
      },
      0,
    );
    expect(out?.text).toBe("Here is the serene landscape 🌅");
    expect(out?.mediaPaths).toEqual(["/Users/me/.openclaw/media/tool-image-generation/x.png"]);
  });

  it("captures multiple MEDIA: lines and leaves text without markers untouched", () => {
    const out = normalizeHistoryMessage(
      { role: "assistant", content: "two files\nMEDIA:/a/x.png\nMEDIA:/a/y.mp4", ...meta("a2", 1) },
      0,
    );
    expect(out?.text).toBe("two files");
    expect(out?.mediaPaths).toEqual(["/a/x.png", "/a/y.mp4"]);
    const plain = normalizeHistoryMessage(
      { role: "user", content: "no media here", ...meta("u", 1) },
      0,
    );
    expect(plain?.mediaPaths).toBeUndefined();
  });

  it("extracts Codex exec stdout from a `toolResult`-typed content block", () => {
    // Codex (app-server) persists bash/exec stdout in a content block whose `type` is
    // "toolResult" (not "text"); the native path only ever emits "text" blocks. Before the
    // fix this fell through `default` and the command output was dropped (text="").
    const out = normalizeHistoryMessage(
      {
        role: "toolResult",
        toolCallId: "call_GSu3",
        toolName: "bash",
        content: [
          {
            type: "toolResult",
            toolCallId: "call_GSu3",
            name: "bash",
            content: "Applications\nDesktop\nDocuments",
            text: "Applications\nDesktop\nDocuments",
          },
        ],
        ...meta("tr-1", 3),
      },
      0,
    );
    expect(out?.role).toBe("toolResult");
    expect(out?.toolResult?.text).toBe("Applications\nDesktop\nDocuments");
    expect(out?.toolResult?.toolCallId).toBe("call_GSu3");
  });

  it("flags compaction records via __openclaw.kind", () => {
    const out = normalizeHistoryMessage(
      {
        role: "system",
        content: [{ type: "text", text: "Compaction" }],
        ...meta("c1", 9, { kind: "compaction" }),
      },
      0,
    );
    expect(out?.kind).toBe("compaction");
    expect(out?.role).toBe("system");
  });
});

describe("normalizeHistoryMessages", () => {
  it("drops unparseable entries and sorts by seq", () => {
    const result = normalizeHistoryMessages([
      { role: "assistant", content: "b", __openclaw: { id: "b", seq: 2 } },
      "garbage",
      { role: "user", content: "a", __openclaw: { id: "a", seq: 1 } },
    ]);
    expect(result.map((m) => m.id)).toEqual(["a", "b"]);
  });

  // Codex-backed sessions can persist the SAME user prompt twice — once at run
  // start and once inside the run-end mirror batch — with distinct transcript
  // entry ids but an identical `idempotencyKey` (a core session-cache bug the
  // key was meant to prevent). Collapse those here so history rebuild doesn't
  // render duplicate user bubbles; the first (send-time) record wins.
  it("collapses entries sharing an idempotencyKey, keeping the first", () => {
    const key = "codex-app-server:019f56de…1cc3:prompt";
    const result = normalizeHistoryMessages([
      {
        role: "user",
        content: "hello",
        idempotencyKey: key,
        __openclaw: { id: "first", seq: 1 },
      },
      {
        role: "user",
        content: "hello",
        idempotencyKey: key,
        __openclaw: { id: "mirror-dup", seq: 2 },
      },
      {
        role: "assistant",
        content: "hi",
        idempotencyKey: "codex-app-server:019f56de…1cc3:assistant",
        __openclaw: { id: "reply", seq: 3 },
      },
    ]);
    expect(result.map((m) => m.id)).toEqual(["first", "reply"]);
  });

  it("does not collapse distinct messages lacking an idempotencyKey", () => {
    const result = normalizeHistoryMessages([
      { role: "user", content: "same text", __openclaw: { id: "u1", seq: 1 } },
      { role: "user", content: "same text", __openclaw: { id: "u2", seq: 2 } },
    ]);
    expect(result.map((m) => m.id)).toEqual(["u1", "u2"]);
  });
});
