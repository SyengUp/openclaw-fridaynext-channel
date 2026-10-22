import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken } from "../middleware/auth.js";
import { readJsonBody } from "../middleware/body.js";
import { toSessionStoreKey } from "../../session/session-manager.js";
import { getOpenClawChannelService } from "../../adapters/openclaw/channel-service.js";
export * from "../../adapters/openclaw/execution.js";

// 旧 App 输入与回执转换；准入、账本和后台执行均使用 Kit 的同一个运行层。
export async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const reply = (status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
    return true;
  };
  if (req.method !== "POST") return reply(405, { error: "Method Not Allowed" });
  if (!extractBearerToken(req)) return reply(401, { error: "Unauthorized: bearer token mismatch" });
  const payload = await readJsonBody(req);
  if (!payload) return reply(400, { error: "Invalid JSON body" });
  const service = getOpenClawChannelService();
  if (
    typeof payload.expectedServerInstanceId === "string" &&
    payload.expectedServerInstanceId !== service.store.serverInstanceId
  )
    return reply(409, { code: "SERVICE_IDENTITY_CHANGED" });
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey.trim() : "";
  if (!sessionKey) return reply(400, { error: "Missing required field: sessionKey" });
  const deviceId =
    typeof payload.deviceId === "string" ? payload.deviceId.trim().toUpperCase() : "";
  if (!deviceId) return reply(400, { error: "Missing required field: deviceId" });
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments.filter((value): value is string => typeof value === "string")
    : [];
  if (!text && !attachments.length)
    return reply(400, { error: "Missing required field: text or attachments" });
  const clientRequestId =
    typeof payload.clientRequestId === "string" ? payload.clientRequestId.trim() : "";
  if (
    new URL(req.url ?? "/friday-next/messages", "http://localhost").pathname ===
      "/friday-next/v3/messages" &&
    !clientRequestId
  )
    return reply(400, { error: "Missing required field: clientRequestId" });
  const sessionOptions: Record<string, unknown> = {};
  for (const key of ["modelRef", "reasoningLevel", "thinkingLevel", "permissionMode"])
    if (payload[key] !== undefined) sessionOptions[key] = payload[key];
  const accepted = await service.runner.admit({
    deviceId,
    sessionKey: toSessionStoreKey(sessionKey),
    agentId:
      typeof payload.agentId === "string"
        ? payload.agentId
        : toSessionStoreKey(sessionKey).split(":")[1] || "main",
    clientRequestId: clientRequestId || crypto.randomUUID(),
    text,
    attachments,
    sessionOptions,
  });
  if (!accepted.run || accepted.outcome === "conflict" || accepted.outcome === "deleted")
    return reply(409, {
      error:
        accepted.outcome === "deleted"
          ? "clientRequestId belonged to a deleted session"
          : "clientRequestId was already used with a different payload",
      clientRequestId,
      runId: accepted.run?.runId ?? accepted.deletedRunId,
    });
  const run = accepted.run;
  reply(202, {
    accepted: true,
    deviceId,
    runId: run.runId,
    ...(clientRequestId ? { protocolVersion: 3, clientRequestId, phase: run.phase } : {}),
    ...(accepted.outcome === "replayed" ? { replayed: true } : {}),
  });
  await service.runner.schedule(run);
  return true;
}
