import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleTts } from "./tts.js";
import { setMockRuntime } from "../../test-support/mock-runtime.js";
import { setFridayNextRuntime } from "../../runtime.js";

const { dispatch, resolveConfig } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  resolveConfig: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({ dispatchGatewayMethod: dispatch }));
vi.mock("openclaw/plugin-sdk/tts-runtime", () => ({ resolveTtsConfig: resolveConfig }));

async function invoke(method: string, path: string, body?: unknown, headers = {}) {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  ) as IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = headers;
  let output = "";
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: (data: string) => {
      output = data;
    },
  };
  const handled = await handleTts(req, res as unknown as ServerResponse);
  return { handled, status: res.statusCode, body: output ? JSON.parse(output) : null };
}

describe("网关 TTS 朗读", () => {
  it("公网请求必须通过 App Attest", async () => {
    setFridayNextRuntime({
      config: {
        current: () => ({ channels: { "friday-next": { appAttest: { required: true } } } }),
      },
    });
    const result = await invoke(
      "POST",
      "/friday-next-admin/tts/speak",
      { text: "回答" },
      { "x-fridaynext-public": "1" },
    );
    expect(result.status).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    setMockRuntime({ authToken: "test-token" });
    dispatch.mockReset();
    resolveConfig.mockReturnValue({ maxTextLength: 4000, apiKey: "不可输出的凭据" });
  });

  it("只把正文交给 tts.speak，不接受客户端的模型和音色覆盖", async () => {
    dispatch.mockResolvedValue({
      ok: true,
      payload: {
        audioBase64: "YWI=",
        provider: "openai",
        mimeType: "audio/mpeg",
        apiKey: "private",
        audioPath: "/private/audio",
      },
    });
    const result = await invoke("POST", "/friday-next-admin/tts/speak", {
      text: " 回答 ",
      modelId: "override",
      voiceId: "override",
      provider: "other",
      includeSecrets: true,
    });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("tts.speak", { text: "回答" });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      ok: true,
      audioBase64: "YWI=",
      provider: "openai",
      mimeType: "audio/mpeg",
    });
  });

  it("读取核心规范化的文本上限且不返回凭据", async () => {
    const result = await invoke("GET", "/friday-next-admin/tts/config");
    expect(result.body).toEqual({ ok: true, maxTextLength: 4000 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([{}, { text: " \n" }, { text: 123 }])("拒绝空正文 %j", async (body) => {
    expect((await invoke("POST", "/friday-next-admin/tts/speak", body)).status).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("空音频不能伪装为成功", async () => {
    dispatch.mockResolvedValue({ ok: true, payload: { audioBase64: "" } });
    expect((await invoke("POST", "/friday-next-admin/tts/speak", { text: "回答" })).status).toBe(
      502,
    );
  });

  it("保留核心配置失败，不转调 Talk 或本机语音", async () => {
    dispatch.mockResolvedValue({
      ok: false,
      error: { code: "UNAVAILABLE", message: "TTS provider not configured" },
    });
    const result = await invoke("POST", "/friday-next-admin/tts/speak", { text: "回答" });
    expect(result.status).toBe(503);
    expect(result.body.code).toBe("UNAVAILABLE");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("方法和路由不匹配时不合成语音", async () => {
    expect((await invoke("GET", "/friday-next-admin/tts/speak")).status).toBe(405);
    expect((await invoke("POST", "/friday-next-admin/tts/config")).status).toBe(405);
    expect((await invoke("GET", "/friday-next-admin/tts/unknown")).handled).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
