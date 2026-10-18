import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { readJsonBody } from "../middleware/body.js";
import { isPublicRequest } from "../middleware/public-surface.js";
import { verifySession } from "../../attest/attest-store.js";
import { attestGateDecision, ATTEST_REJECTION_BODY } from "../../attest/attest-gate.js";
import { resolveFridayNextConfig } from "../../config.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { getFridayNextRuntime } from "../../runtime.js";

function json(res: ServerResponse, status: number, body: Record<string, unknown>): true {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
  return true;
}

/** 单条消息朗读只提交文本，模型、音色和提供方均由核心 TTS 配置决定。 */
export async function handleTts(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "");
  const isConfig = pathname === "/friday-next-admin/tts/config";
  if (!isConfig && pathname !== "/friday-next-admin/tts/speak") return false;
  const cfg = getHostOpenClawConfigSnapshot(getFridayNextRuntime().config);
  if (isPublicRequest(req)) {
    const attestCfg = resolveFridayNextConfig(cfg);
    if (
      attestGateDecision({
        pathname,
        headers: req.headers,
        isPublic: true,
        required: attestCfg.appAttest.required,
        scope: "plugin",
        verify: (token) => verifySession(token, Date.now()),
      }) === "reject"
    )
      return json(res, 403, { ...ATTEST_REJECTION_BODY });
  }
  if (req.method !== (isConfig ? "GET" : "POST")) {
    return json(res, 405, { ok: false, error: "Method Not Allowed" });
  }
  try {
    if (isConfig) {
      // 只返回分段所需的上限，凭据和提供方配置始终留在网关。
      const { resolveTtsConfig } = await import("openclaw/plugin-sdk/tts-runtime");
      return json(res, 200, { ok: true, maxTextLength: resolveTtsConfig(cfg).maxTextLength });
    }
    const body = await readJsonBody(req);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return json(res, 400, { ok: false, error: "tts.speak requires text" });
    const response = await dispatchGatewayMethod("tts.speak", { text });
    if (!response.ok) {
      const code = response.error?.code;
      return json(res, code === "INVALID_REQUEST" ? 400 : 503, {
        ok: false,
        code,
        error: response.error?.message ?? "TTS synthesis failed",
      });
    }
    const payload = (response.payload ?? {}) as Record<string, unknown>;
    // 明确限定输出，不能把核心将来新增的内部字段或文件路径直接透传给客户端。
    if (typeof payload.audioBase64 !== "string" || !payload.audioBase64.length) {
      return json(res, 502, { ok: false, error: "TTS returned empty audio" });
    }
    return json(res, 200, {
      ok: true,
      audioBase64: payload.audioBase64,
      provider: payload.provider,
      outputFormat: payload.outputFormat,
      mimeType: payload.mimeType,
    });
  } catch {
    return json(res, 503, { ok: false, error: "Gateway TTS is unavailable" });
  }
}
