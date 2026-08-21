import { describe, expect, it, vi } from "vitest";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  completeTalkRelayToolCall,
  resolveTalkConsultSessionKey,
} from "./talk-consult.js";

describe("talk-consult", () => {
  it("prefers the requested session key then the stored key", () => {
    expect(resolveTalkConsultSessionKey("stored", " requested ")).toBe("requested");
    expect(resolveTalkConsultSessionKey("stored", undefined)).toBe("stored");
    expect(resolveTalkConsultSessionKey(undefined, undefined)).toBe("agent:main:fridaynext-talk");
  });

  it("starts a consult, waits, and submits the assistant text", async () => {
    const dispatch = vi.fn(async (method: string) => {
      if (method === "talk.client.toolCall") {
        return { ok: true, payload: { runId: "run-1", idempotencyKey: "idem-1" } };
      }
      if (method === "agent.wait") {
        return { ok: true, payload: { status: "ok" } };
      }
      if (method === "talk.session.submitToolResult") {
        return { ok: true, payload: {} };
      }
      return { ok: false, payload: {}, error: `unexpected ${method}` };
    });
    const result = await completeTalkRelayToolCall({
      sessionId: "sess-1",
      sessionKey: "agent:main:chat",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "今天天气" },
      dispatch,
      loadAssistantText: async () => "北京晴，24 度",
    });
    expect(result).toEqual({ ok: true, runId: "run-1" });
    expect(dispatch).toHaveBeenNthCalledWith(1, "talk.client.toolCall", {
      sessionKey: "agent:main:chat",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "今天天气" },
      relaySessionId: "sess-1",
    });
    expect(dispatch).toHaveBeenNthCalledWith(2, "agent.wait", {
      runId: "run-1",
      timeoutMs: 120_000,
    });
    expect(dispatch).toHaveBeenNthCalledWith(3, "talk.session.submitToolResult", {
      sessionId: "sess-1",
      callId: "call-1",
      result: { text: "北京晴，24 度", result: "北京晴，24 度" },
    });
  });

  it("submits a working continuation before a forced consult", async () => {
    const dispatch = vi.fn(async (method: string) => {
      if (method === "talk.client.toolCall") {
        return { ok: true, payload: { runId: "run-forced" } };
      }
      if (method === "agent.wait") {
        return { ok: true, payload: { status: "ok" } };
      }
      return { ok: true, payload: {} };
    });
    await completeTalkRelayToolCall({
      sessionId: "sess-1",
      sessionKey: "agent:main:chat",
      callId: "forced-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "天气" },
      forced: true,
      dispatch,
      loadAssistantText: async () => "晴",
    });
    expect(dispatch.mock.calls[0]?.[0]).toBe("talk.session.submitToolResult");
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
      callId: "forced-1",
      options: { willContinue: true },
      result: { status: "working", tool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME },
    });
  });

  it("feeds a timeout back to the realtime provider", async () => {
    const dispatch = vi.fn(async (method: string) => {
      if (method === "talk.client.toolCall") {
        return { ok: true, payload: { runId: "run-timeout" } };
      }
      if (method === "agent.wait") {
        return { ok: true, payload: { status: "timeout" } };
      }
      return { ok: true, payload: {} };
    });
    const result = await completeTalkRelayToolCall({
      sessionId: "sess-1",
      sessionKey: "agent:main:chat",
      callId: "call-timeout",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      dispatch,
      loadAssistantText: async () => null,
    });
    expect(result.ok).toBe(false);
    expect(dispatch).toHaveBeenLastCalledWith("talk.session.submitToolResult", {
      sessionId: "sess-1",
      callId: "call-timeout",
      result: { error: "OpenClaw tool call timed out" },
    });
  });

  it("feeds the session reply even when agent.wait reports a tool error", async () => {
    const dispatch = vi.fn(async (method: string) => {
      if (method === "talk.client.toolCall") {
        return { ok: true, payload: { runId: "run-weather" } };
      }
      if (method === "agent.wait") {
        return { ok: true, payload: { status: "error", error: "exec failed" } };
      }
      return { ok: true, payload: {} };
    });
    const result = await completeTalkRelayToolCall({
      sessionId: "sess-1",
      sessionKey: "agent:main:chat",
      callId: "call-weather",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      dispatch,
      loadAssistantText: async () => "北京晴，24 度",
    });
    expect(result).toEqual({ ok: true, runId: "run-weather" });
    expect(dispatch).toHaveBeenLastCalledWith("talk.session.submitToolResult", {
      sessionId: "sess-1",
      callId: "call-weather",
      result: { text: "北京晴，24 度", result: "北京晴，24 度" },
    });
  });

  it("uses agent.wait terminalReply when the transcript is still empty", async () => {
    const dispatch = vi.fn(async (method: string) => {
      if (method === "talk.client.toolCall") {
        return { ok: true, payload: { runId: "run-wait-reply" } };
      }
      if (method === "agent.wait") {
        return {
          ok: true,
          payload: {
            status: "ok",
            terminalReply: { disposition: "visible", text: "上海多云，18 度" },
          },
        };
      }
      return { ok: true, payload: {} };
    });
    const result = await completeTalkRelayToolCall({
      sessionId: "sess-1",
      sessionKey: "agent:main:chat",
      callId: "call-terminal",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      dispatch,
      loadAssistantText: async () => null,
    });
    expect(result).toEqual({ ok: true, runId: "run-wait-reply" });
    expect(dispatch).toHaveBeenLastCalledWith("talk.session.submitToolResult", {
      sessionId: "sess-1",
      callId: "call-terminal",
      result: { text: "上海多云，18 度", result: "上海多云，18 度" },
    });
  });

  it("steers an active consult for the control tool", async () => {
    const dispatch = vi.fn(async (method: string) => {
      if (method === "talk.session.steer") {
        return { ok: true, payload: { ok: true, mode: "cancel", message: "stopped" } };
      }
      return { ok: true, payload: {} };
    });
    const result = await completeTalkRelayToolCall({
      sessionId: "sess-1",
      sessionKey: "agent:main:chat",
      callId: "ctrl-1",
      name: REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
      args: { text: "停", mode: "cancel" },
      dispatch,
    });
    expect(result.ok).toBe(true);
    expect(dispatch).toHaveBeenNthCalledWith(1, "talk.session.steer", {
      sessionId: "sess-1",
      sessionKey: "agent:main:chat",
      text: "停",
      mode: "cancel",
    });
    expect(dispatch).toHaveBeenNthCalledWith(2, "talk.session.submitToolResult", {
      sessionId: "sess-1",
      callId: "ctrl-1",
      result: { ok: true, mode: "cancel", message: "stopped" },
    });
  });
});
