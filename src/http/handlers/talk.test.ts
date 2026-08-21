// Tests for /friday-next-admin/talk/* — Native Talk catalog/config/speak/mode
// forwarded to the canonical gateway `talk.*` methods.
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTalk } from "./talk.js";
import { clearFridayNextRuntime, setFridayNextRuntime } from "../../runtime.js";
import { resetTalkSessionBridgeForTest } from "../../talk/talk-session-bridge.js";
import { resetTalkRuntimeForTest } from "../../talk/talk-runtime.js";

const { dispatchGatewayMethod, getPluginRuntimeGatewayRequestScope } = vi.hoisted(() => ({
  dispatchGatewayMethod: vi.fn(),
  getPluginRuntimeGatewayRequestScope: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({
  dispatchGatewayMethod,
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope,
}));

type IncomingMessageLike = import("node:http").IncomingMessage;
type ServerResponseLike = import("node:http").ServerResponse;
type Captured = { statusCode: number; headers: Record<string, unknown>; body: string };

function makeReq(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): IncomingMessageLike {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf-8")];
  const req = Readable.from(chunks) as unknown as IncomingMessageLike;
  req.method = method;
  req.url = url;
  req.headers = headers;
  return req;
}

function makeRes(): { res: ServerResponseLike; captured: Captured } {
  const captured: Captured = { statusCode: 200, headers: {}, body: "" };
  const res = {
    get statusCode() {
      return captured.statusCode;
    },
    set statusCode(v: number) {
      captured.statusCode = v;
    },
    setHeader(name: string, value: unknown) {
      captured.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string | Buffer) {
      captured.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : (chunk ?? "");
    },
  } as unknown as ServerResponseLike;
  return { res, captured };
}

async function invoke(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const { res, captured } = makeRes();
  const handled = await handleTalk(makeReq(method, url, body, headers), res);
  return {
    handled,
    captured,
    json: captured.body ? (JSON.parse(captured.body) as Record<string, unknown>) : undefined,
  };
}

describe("handleTalk", () => {
  beforeEach(() => {
    dispatchGatewayMethod.mockReset();
    getPluginRuntimeGatewayRequestScope.mockReset();
    getPluginRuntimeGatewayRequestScope.mockReturnValue({
      client: {},
      context: { broadcastToConnIds: vi.fn() },
    });
    resetTalkSessionBridgeForTest();
    resetTalkRuntimeForTest();
  });

  afterEach(() => {
    clearFridayNextRuntime();
  });

  it("returns false for an unknown talk path", async () => {
    const { handled, captured } = await invoke("GET", "/friday-next-admin/talk/unknown");
    expect(handled).toBe(false);
    expect(captured.body).toBe("");
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  describe("catalog", () => {
    it("dispatches talk.catalog with empty params and returns the payload", async () => {
      dispatchGatewayMethod.mockResolvedValue({
        ok: true,
        payload: { modes: ["realtime", "stt-tts"], speech: { providers: [] } },
      });
      const { captured, json } = await invoke("GET", "/friday-next-admin/talk/catalog");
      expect(dispatchGatewayMethod).toHaveBeenCalledWith("talk.catalog", {});
      expect(captured.statusCode).toBe(200);
      expect(json).toMatchObject({ ok: true, modes: ["realtime", "stt-tts"] });
    });

    it("returns 405 for non-GET", async () => {
      const { captured } = await invoke("POST", "/friday-next-admin/talk/catalog", {});
      expect(captured.statusCode).toBe(405);
      expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    });
  });

  describe("config", () => {
    it("dispatches talk.config without includeSecrets", async () => {
      dispatchGatewayMethod.mockResolvedValue({
        ok: true,
        payload: { config: { provider: "elevenlabs" } },
      });
      const { json } = await invoke("GET", "/friday-next-admin/talk/config?includeSecrets=true");
      expect(dispatchGatewayMethod).toHaveBeenCalledWith("talk.config", {});
      expect(json).toMatchObject({ ok: true, config: { provider: "elevenlabs" } });
    });

    it("returns 405 for non-GET", async () => {
      const { captured } = await invoke("POST", "/friday-next-admin/talk/config", {
        includeSecrets: true,
      });
      expect(captured.statusCode).toBe(405);
      expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    });
  });

  describe("speak", () => {
    it("forwards the whitelist and drops unknown keys", async () => {
      dispatchGatewayMethod.mockResolvedValue({
        ok: true,
        payload: { audioBase64: "YWI=", provider: "elevenlabs", outputFormat: "pcm_44100" },
      });
      const { captured, json } = await invoke("POST", "/friday-next-admin/talk/speak", {
        text: "hello",
        voiceId: "cedar",
        modelId: "eleven_v3",
        outputFormat: "pcm_44100",
        speed: 1.1,
        apiKey: "should-not-forward",
        includeSecrets: true,
      });
      expect(dispatchGatewayMethod).toHaveBeenCalledWith("talk.speak", {
        text: "hello",
        voiceId: "cedar",
        modelId: "eleven_v3",
        outputFormat: "pcm_44100",
        speed: 1.1,
      });
      expect(captured.statusCode).toBe(200);
      expect(json).toMatchObject({ ok: true, audioBase64: "YWI=", provider: "elevenlabs" });
    });

    it("returns 400 when text is missing", async () => {
      const { captured, json } = await invoke("POST", "/friday-next-admin/talk/speak", {
        voiceId: "cedar",
      });
      expect(captured.statusCode).toBe(400);
      expect(json).toMatchObject({ ok: false, error: "talk.speak requires text" });
      expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    });

    it("returns 405 for non-POST", async () => {
      const { captured } = await invoke("GET", "/friday-next-admin/talk/speak");
      expect(captured.statusCode).toBe(405);
      expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    });

    it("maps UNAVAILABLE to 503 and forwards details for TTS fallback", async () => {
      dispatchGatewayMethod.mockResolvedValue({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "talk.speak unavailable: talk provider not configured",
          details: { reason: "talk_unconfigured", fallbackEligible: true },
        },
      });
      const { captured, json } = await invoke("POST", "/friday-next-admin/talk/speak", {
        text: "hello",
      });
      expect(captured.statusCode).toBe(503);
      expect(json).toMatchObject({
        ok: false,
        code: "UNAVAILABLE",
        details: { fallbackEligible: true },
      });
    });
  });

  describe("mode", () => {
    it("dispatches talk.mode with enabled and optional phase", async () => {
      dispatchGatewayMethod.mockResolvedValue({
        ok: true,
        payload: { enabled: true, phase: "listening", ts: 1 },
      });
      const { json } = await invoke("POST", "/friday-next-admin/talk/mode", {
        enabled: true,
        phase: "listening",
        extra: "drop-me",
      });
      expect(dispatchGatewayMethod).toHaveBeenCalledWith("talk.mode", {
        enabled: true,
        phase: "listening",
      });
      expect(json).toMatchObject({ ok: true, enabled: true, phase: "listening" });
    });

    it("returns 400 when enabled is missing", async () => {
      const { captured, json } = await invoke("POST", "/friday-next-admin/talk/mode", {
        phase: "listening",
      });
      expect(captured.statusCode).toBe(400);
      expect(json).toMatchObject({ ok: false });
      expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    });

    it("returns 405 for non-POST", async () => {
      const { captured } = await invoke("GET", "/friday-next-admin/talk/mode");
      expect(captured.statusCode).toBe(405);
      expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    });
  });

  it("returns 500 when dispatch throws", async () => {
    dispatchGatewayMethod.mockRejectedValue(new Error("dispatch reserved for contracts"));
    const { captured, json } = await invoke("GET", "/friday-next-admin/talk/catalog");
    expect(captured.statusCode).toBe(500);
    expect(json).toMatchObject({ ok: false });
  });

  it("rejects a public request without an attest token when required", async () => {
    setFridayNextRuntime({
      config: {
        current: () => ({ channels: { "friday-next": { appAttest: { required: true } } } }),
      },
    });
    const { captured, json } = await invoke("GET", "/friday-next-admin/talk/catalog", undefined, {
      "x-fridaynext-public": "1",
    });
    expect(captured.statusCode).toBe(403);
    expect(json).toMatchObject({ code: "attest_required" });
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  describe("session", () => {
    it("returns false for an unknown nested talk path", async () => {
      const { handled, captured } = await invoke("POST", "/friday-next-admin/talk/session/unknown", {
        deviceId: "D1",
      });
      expect(handled).toBe(false);
      expect(captured.body).toBe("");
      expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    });

    it("creates a realtime relay session and stamps a synthetic connId", async () => {
      const scope = {
        client: {} as { connId?: string },
        context: { broadcastToConnIds: vi.fn() },
      };
      getPluginRuntimeGatewayRequestScope.mockReturnValue(scope);
      dispatchGatewayMethod.mockResolvedValue({
        ok: true,
        payload: { sessionId: "sess-1", mode: "realtime", transport: "gateway-relay" },
      });
      const { captured, json } = await invoke("POST", "/friday-next-admin/talk/session", {
        deviceId: "phone-1",
        sessionKey: "agent:main:chat",
        extra: "drop-me",
      });
      expect(captured.statusCode).toBe(200);
      expect(json).toMatchObject({
        ok: true,
        sessionId: "sess-1",
        mode: "realtime",
        transport: "gateway-relay",
      });
      expect(dispatchGatewayMethod).toHaveBeenCalledWith("talk.session.create", {
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        sessionKey: "agent:main:chat",
      });
      expect(scope.client.connId).toMatch(/^friday-talk:PHONE-1:/);
    });

    it("returns 400 when deviceId is missing", async () => {
      const { captured, json } = await invoke("POST", "/friday-next-admin/talk/session", {
        sessionKey: "agent:main:chat",
      });
      expect(captured.statusCode).toBe(400);
      expect(json).toMatchObject({ ok: false });
      expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    });

    it("returns 503 when the request scope has no client", async () => {
      getPluginRuntimeGatewayRequestScope.mockReturnValue(undefined);
      const { captured, json } = await invoke("POST", "/friday-next-admin/talk/session", {
        deviceId: "phone-1",
      });
      expect(captured.statusCode).toBe(503);
      expect(json).toMatchObject({ ok: false, code: "UNAVAILABLE" });
      expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    });

    it("relays a consult tool call after create", async () => {
      dispatchGatewayMethod
        .mockResolvedValueOnce({
          ok: true,
          payload: { sessionId: "sess-tool" },
        })
        .mockResolvedValueOnce({
          ok: true,
          payload: { runId: "run-weather", idempotencyKey: "idem-weather" },
        })
        .mockResolvedValueOnce({ ok: true, payload: { status: "ok" } })
        .mockResolvedValueOnce({ ok: true, payload: {} });
      setFridayNextRuntime({
        subagent: {
          getSessionMessages: async () => ({
            messages: [{ role: "assistant", text: "晴，24 度", seq: 1 }],
          }),
        },
      } as never);
      await invoke("POST", "/friday-next-admin/talk/session", {
        deviceId: "phone-1",
        sessionKey: "agent:main:chat",
      });
      const { captured, json } = await invoke("POST", "/friday-next-admin/talk/session/tool-call", {
        sessionId: "sess-tool",
        callId: "call-1",
        name: "openclaw_agent_consult",
        args: { question: "天气" },
      });
      expect(captured.statusCode).toBe(200);
      expect(json).toMatchObject({ ok: true, runId: "run-weather" });
      expect(dispatchGatewayMethod).toHaveBeenCalledWith("talk.client.toolCall", {
        sessionKey: "agent:main:chat",
        callId: "call-1",
        name: "openclaw_agent_consult",
        args: { question: "天气" },
        relaySessionId: "sess-tool",
      });
      expect(dispatchGatewayMethod).toHaveBeenCalledWith("agent.wait", {
        runId: "run-weather",
        timeoutMs: 120_000,
      });
      expect(dispatchGatewayMethod).toHaveBeenCalledWith("talk.session.submitToolResult", {
        sessionId: "sess-tool",
        callId: "call-1",
        result: { text: "晴，24 度", result: "晴，24 度" },
      });
    });

    it("returns 404 for a tool call on an unknown session", async () => {
      const { captured, json } = await invoke("POST", "/friday-next-admin/talk/session/tool-call", {
        sessionId: "missing",
        callId: "call-1",
        name: "openclaw_agent_consult",
      });
      expect(captured.statusCode).toBe(404);
      expect(json).toMatchObject({ ok: false });
      expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    });

    it("forwards appendAudio after create", async () => {
      dispatchGatewayMethod
        .mockResolvedValueOnce({
          ok: true,
          payload: { sessionId: "sess-2" },
        })
        .mockResolvedValueOnce({ ok: true, payload: {} });
      await invoke("POST", "/friday-next-admin/talk/session", { deviceId: "phone-1" });
      const { captured, json } = await invoke("POST", "/friday-next-admin/talk/session/audio", {
        sessionId: "sess-2",
        audioBase64: "YWI=",
        timestamp: 1.5,
      });
      expect(captured.statusCode).toBe(200);
      expect(json).toMatchObject({ ok: true });
      expect(dispatchGatewayMethod).toHaveBeenLastCalledWith("talk.session.appendAudio", {
        sessionId: "sess-2",
        audioBase64: "YWI=",
        timestamp: 1.5,
      });
    });

    it("returns 404 for audio on an unknown session", async () => {
      const { captured, json } = await invoke("POST", "/friday-next-admin/talk/session/audio", {
        sessionId: "missing",
        audioBase64: "YWI=",
      });
      expect(captured.statusCode).toBe(404);
      expect(dispatchGatewayMethod).not.toHaveBeenCalled();
      expect(json).toMatchObject({ ok: false });
    });

    it("cancels and closes a session", async () => {
      dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { sessionId: "sess-3" } });
      await invoke("POST", "/friday-next-admin/talk/session", { deviceId: "phone-1" });
      dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: {} });
      const cancelled = await invoke("POST", "/friday-next-admin/talk/session/cancel", {
        sessionId: "sess-3",
        reason: "barge-in",
      });
      expect(cancelled.captured.statusCode).toBe(200);
      expect(dispatchGatewayMethod).toHaveBeenLastCalledWith("talk.session.cancelOutput", {
        sessionId: "sess-3",
        reason: "barge-in",
      });
      const closed = await invoke("POST", "/friday-next-admin/talk/session/close", {
        sessionId: "sess-3",
      });
      expect(closed.captured.statusCode).toBe(200);
      expect(dispatchGatewayMethod).toHaveBeenLastCalledWith("talk.session.close", {
        sessionId: "sess-3",
      });
      const again = await invoke("POST", "/friday-next-admin/talk/session/close", {
        sessionId: "sess-3",
      });
      expect(again.captured.statusCode).toBe(404);
    });

    it("rejects a public session create without an attest token when required", async () => {
      setFridayNextRuntime({
        config: {
          current: () => ({ channels: { "friday-next": { appAttest: { required: true } } } }),
        },
      });
      const { captured, json } = await invoke(
        "POST",
        "/friday-next-admin/talk/session",
        { deviceId: "phone-1" },
        { "x-fridaynext-public": "1" },
      );
      expect(captured.statusCode).toBe(403);
      expect(json).toMatchObject({ code: "attest_required" });
      expect(dispatchGatewayMethod).not.toHaveBeenCalled();
    });
  });
});
