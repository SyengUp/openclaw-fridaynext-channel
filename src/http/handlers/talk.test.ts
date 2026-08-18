// Tests for /friday-next-admin/talk/* — Native Talk catalog/config/speak/mode
// forwarded to the canonical gateway `talk.*` methods.
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTalk } from "./talk.js";
import { clearFridayNextRuntime, setFridayNextRuntime } from "../../runtime.js";

const { dispatchGatewayMethod } = vi.hoisted(() => ({
  dispatchGatewayMethod: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({
  dispatchGatewayMethod,
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
});
