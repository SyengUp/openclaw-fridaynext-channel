import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { isPublicRequest } from "../middleware/public-surface.js";
import { readJsonBody } from "../middleware/body.js";
import { verifySession } from "../../attest/attest-store.js";
import { attestGateDecision, ATTEST_REJECTION_BODY } from "../../attest/attest-gate.js";
import { resolveFridayNextConfig } from "../../config.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { getFridayNextRuntime } from "../../runtime.js";
import { resolveSessionId } from "../../history/read-transcript.js";
import { getRuntimeV3Store } from "../../runtime-v3/runtime-store.js";

function json(res: ServerResponse, status: number, body: Record<string, unknown>): true {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
  return true;
}

const errorStatuses: Record<string, number> = {
  INVALID_REQUEST: 400,
  NOT_LINKED: 409,
  NOT_PAIRED: 409,
  FORBIDDEN: 403,
  UNAVAILABLE: 503,
  AGENT_TIMEOUT: 504,
};

/** 只桥接官方消息切点 RPC；历史分支、运行护栏及回填媒体始终由核心维护。 */
async function handleAction(
  action: "rewind" | "fork",
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method Not Allowed" });
  if (isPublicRequest(req)) {
    const cfg = resolveFridayNextConfig(
      getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
    );
    if (
      attestGateDecision({
        pathname: `/friday-next-admin/sessions/${action}`,
        headers: req.headers,
        isPublic: true,
        required: cfg.appAttest.required,
        scope: "plugin",
        verify: (token) => verifySession(token, Date.now()),
      }) === "reject"
    )
      return json(res, 403, { ...ATTEST_REJECTION_BODY });
  }

  const body = await readJsonBody(req, 32 * 1024);
  const sessionKey = typeof body?.sessionKey === "string" ? body.sessionKey.trim() : "";
  const entryId = typeof body?.entryId === "string" ? body.entryId.trim() : "";
  const agentId = typeof body?.agentId === "string" ? body.agentId.trim() : undefined;
  if (!sessionKey || !entryId || (body?.agentId !== undefined && !agentId)) {
    return json(res, 400, {
      ok: false,
      code: "INVALID_REQUEST",
      error: "Invalid sessionKey, entryId or agentId",
    });
  }
  try {
    const store = getRuntimeV3Store();
    const runs = store
      .runs()
      .filter((run) => run.sessionKey.toLowerCase() === sessionKey.toLowerCase());
    if (runs.some((run) => !["completed", "failed", "cancelled"].includes(run.phase))) {
      return json(res, 503, {
        ok: false,
        code: "UNAVAILABLE",
        error: "Session has running or queued messages",
      });
    }
    const conversationId = resolveSessionId(sessionKey);
    if (conversationId) {
      for (const run of runs) store.bindRunConversation(run.runId, conversationId);
    }
    const response = await dispatchGatewayMethod(`sessions.${action}`, {
      sessionKey,
      entryId,
      ...(agentId ? { agentId } : {}),
    });
    if (!response.ok) {
      const code = response.error?.code;
      return json(res, errorStatuses[code ?? ""] ?? 500, {
        ok: false,
        error: response.error?.message ?? `sessions.${action} failed`,
        ...(code ? { code } : {}),
      });
    }
    // 不清除插件运行账本：旧分支的任务审计与设备级重放游标仍然有效。
    return json(res, 200, { ...((response.payload ?? {}) as Record<string, unknown>), ok: true });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const handleSessionRewind = (req: IncomingMessage, res: ServerResponse): Promise<boolean> =>
  handleAction("rewind", req, res);
export const handleSessionFork = (req: IncomingMessage, res: ServerResponse): Promise<boolean> =>
  handleAction("fork", req, res);
