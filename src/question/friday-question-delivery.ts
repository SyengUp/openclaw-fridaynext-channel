import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { ensureGatewayRequestScopes } from "../agent/operator-scope.js";
import { sseEmitter } from "../sse/emitter.js";
import { noteFridayQuestionPrompt, readFridayAskUserBinding } from "./friday-question.js";
import { getRuntimeV3Store } from "../runtime-v3/runtime-store.js";

/** 频道主动直投也保留完整问题结构，并以核心问题记录确定精确归属。 */
export async function deliverFridayQuestionPayload(
  payload: Record<string, unknown>,
  deviceId: string,
): Promise<boolean> {
  const binding = readFridayAskUserBinding(payload);
  if (!binding) return false;
  ensureGatewayRequestScopes(["operator.questions"]);
  const result = await dispatchGatewayMethod("question.get", { id: binding.questionId });
  if (!result.ok)
    throw new Error(`Question delivery lookup failed: ${result.error?.message ?? "unavailable"}`);
  const record = (
    result.payload as { question?: { status?: string; runId?: string; sessionKey?: string } }
  )?.question;
  if (!record) throw new Error("Question delivery is missing its authoritative record");
  if (record.status !== "pending") return true;
  const runId = record.runId?.trim();
  const sessionKey = record.sessionKey?.trim();
  if (!runId || !sessionKey) throw new Error("Question delivery is missing its run/session route");
  const target = deviceId.trim().toUpperCase();
  getRuntimeV3Store().observeRun({
    runId,
    sessionKey,
    agentId: sessionKey.match(/^agent:([^:]+):/i)?.[1] ?? "main",
    deviceIds: [target],
  });
  await noteFridayQuestionPrompt({
    questionId: binding.questionId,
    runId,
    sessionKey,
    deviceId: target,
  });
  // 先建立精确 observed run，离线且尚未连过 v3 的设备也能从持久队列恢复。
  sseEmitter.broadcast(
    {
      type: "deliver",
      data: {
        kind: "tool",
        payload,
        runId,
        sessionKey,
        deviceId: target,
        ts: Date.now(),
      },
    },
    target,
    true,
  );
  return true;
}
