/**
 * GET /friday-next/progress-card?sessionKey=
 *
 * 会话级进度卡（progress_card 工具）的权威读取：透传 gateway `progressCard.get`，
 * 返回 `{ ok: true, card: ProgressCard | null }`（null = 服务端无卡/已清除）。
 *
 * 为什么需要它：app 的实时更新走 SSE 工具事件、恢复走 transcript 里最后一次调用，
 * 但 Control UI 的 dismiss（progressCard.put 直调，不产生工具调用记录）和超出历史
 * 窗口的旧卡片，transcript 都反映不出来——只有这条权威读能收敛。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { extractBearerToken } from "../middleware/auth.js";

export async function handleProgressCardGet(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return true;
  }

  const token = extractBearerToken(req);
  if (!token) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Unauthorized: bearer token mismatch" }));
    return true;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const sessionKey = url.searchParams.get("sessionKey")?.trim();
  if (!sessionKey) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing required query param: sessionKey" }));
    return true;
  }

  try {
    const response = await dispatchGatewayMethod("progressCard.get", { sessionKey });
    if (!response.ok) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          ok: false,
          error: response.error?.message ?? "progressCard.get failed",
        }),
      );
      return true;
    }
    const payload = (response.payload ?? {}) as { card?: unknown };
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, card: payload.card ?? null }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  }
  return true;
}
