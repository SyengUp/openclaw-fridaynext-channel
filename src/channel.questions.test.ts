import { beforeEach, describe, expect, it, vi } from "vitest";
const { dispatchGatewayMethod } = vi.hoisted(() => ({ dispatchGatewayMethod: vi.fn() }));
vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({ dispatchGatewayMethod }));
import { fridayNextChannelPlugin } from "./channel.js";
import { setMockRuntime } from "./test-support/mock-runtime.js";
import { sseEmitter } from "./sse/emitter.js";
import { getRuntimeV3Store } from "./runtime-v3/runtime-store.js";

describe("频道原生问题能力与完整 payload", () => {
  beforeEach(() => {
    setMockRuntime();
    vi.restoreAllMocks();
    dispatchGatewayMethod.mockReset();
  });
  it("声明最新核心要求的 questionInputMode", () => {
    expect(fridayNextChannelPlugin.agentPrompt?.questionInputMode).toBe("buttons");
  });
  it("主动提问保留完整结构，并使用问题记录的精确 run/session 而非设备最后一次运行", async () => {
    const payload = {
      text: "想听哪类音乐？",
      channelData: { askUser: { questionId: "ask-music" } },
      presentation: { blocks: [{ type: "text", text: "音乐类型" }] },
    };
    dispatchGatewayMethod.mockResolvedValue({
      ok: true,
      payload: {
        question: {
          id: "ask-music",
          status: "pending",
          runId: "question-run",
          sessionKey: "agent:main:fridaynext:music",
        },
      },
    });
    const spy = vi.spyOn(sseEmitter, "broadcast");
    const send = fridayNextChannelPlugin.outbound?.sendPayload;
    expect(send).toBeTypeOf("function");
    await send!({ cfg: {}, to: "dev-1", text: payload.text, payload });
    const event = spy.mock.calls.find(([event]) => event.type === "deliver")?.[0];
    expect(event?.data).toMatchObject({
      kind: "tool",
      payload,
      runId: "question-run",
      sessionKey: "agent:main:fridaynext:music",
    });
    expect(
      getRuntimeV3Store()
        .eventsForRun("question-run")
        .some((event) => event.eventType === "deliver.tool"),
    ).toBe(true);
  });
  it("无权读取的问题不冒充投递成功", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: false, error: { message: "not found" } });
    const send = fridayNextChannelPlugin.outbound?.sendPayload;
    expect(send).toBeTypeOf("function");
    await expect(
      send!({
        cfg: {},
        to: "dev-1",
        text: "问题",
        payload: { text: "问题", channelData: { askUser: { questionId: "missing" } } },
      }),
    ).rejects.toThrow();
  });

  it("普通附件的空 mediaUrls 不得吞掉 mediaUrl，也不做问题查询", async () => {
    const sendMedia = vi.spyOn(fridayNextChannelPlugin.outbound!, "sendMedia").mockResolvedValue({
      channel: "friday-next",
      messageId: "media-fixture",
      timestamp: Date.now(),
    });
    await fridayNextChannelPlugin.outbound!.sendPayload!({
      cfg: {},
      to: "dev-1",
      text: "附件",
      payload: { text: "附件", mediaUrl: "file:///tmp/music.mp3", mediaUrls: [] },
    });
    expect(sendMedia).toHaveBeenCalledTimes(1);
    expect(sendMedia.mock.calls[0][0]).toMatchObject({
      mediaUrl: "file:///tmp/music.mp3",
      text: "附件",
    });
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });
});
