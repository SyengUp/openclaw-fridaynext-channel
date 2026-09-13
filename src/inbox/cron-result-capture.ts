import { loadCronStore, resolveCronStorePath } from "openclaw/plugin-sdk/config-runtime";
import { createFridayNextLogger } from "../logging.js";
import {
  readCronDeliveryTarget,
  type CronDeliveryTarget,
} from "../notifications/cron-delivery-target.js";
import { resolveCronDeliveryFromHook } from "../notifications/cron-delivery-lookup.js";
import {
  clearLegacyNotificationLogOnce,
  cronResultStore,
  type CronResultRecord,
} from "./cron-result-store.js";

const logger = createFridayNextLogger("inbox-cron");
const MAX_PENDING_RUN_FACTS = 1_024;

type CronRunFacts = {
  delivery: CronDeliveryTarget;
  jobName?: string;
  agentId?: string;
};

/** started 与 finished 之间只传递 hook 已确认的同一运行事实，不做时间相关性猜测。 */
const factsByRun = new Map<string, CronRunFacts>();

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function runIdentity(event: Record<string, unknown>): string | undefined {
  const runId = stringValue(event.runId);
  if (runId) return `run:${runId}`;
  const sessionId = stringValue(event.sessionId);
  if (sessionId) return `session:${sessionId}`;
  const runAtMs = finiteNumber(event.runAtMs);
  return runAtMs === undefined ? undefined : `at:${runAtMs}`;
}

function hookJob(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = event.job;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function resolveCurrentFacts(
  jobId: string,
  event: Record<string, unknown>,
  ctx: unknown,
): Promise<CronRunFacts> {
  let delivery = resolveCronDeliveryFromHook(jobId, event, ctx);
  let storedJob: Record<string, unknown> | undefined;
  if (delivery.deliversToFridayNext === null || !stringValue(hookJob(event)?.name)) {
    try {
      const store = await loadCronStore(resolveCronStorePath());
      const found = store.jobs.find((job) => job?.id === jobId);
      if (found && typeof found === "object") {
        storedJob = found as unknown as Record<string, unknown>;
        if (delivery.deliversToFridayNext === null) delivery = readCronDeliveryTarget(found);
      }
    } catch {
      /* 无法读取即保持 unknown；分类必须 fail closed。 */
    }
  }
  const eventJob = hookJob(event);
  return {
    delivery,
    jobName: stringValue(eventJob?.name) ?? stringValue(storedJob?.name),
    agentId:
      stringValue(eventJob?.agentId) ??
      stringValue(event.agentId) ??
      stringValue(storedJob?.agentId),
  };
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * 唯一允许生成 cron 收件箱历史的入口。普通 outbound、message tool、heartbeat 和 worker
 * 永远不会调用这里，因此正文内容与在线状态均不参与分类。
 */
export async function captureCronChanged(
  eventValue: unknown,
  ctx?: unknown,
): Promise<CronResultRecord | null> {
  if (!eventValue || typeof eventValue !== "object" || Array.isArray(eventValue)) return null;
  const event = eventValue as Record<string, unknown>;
  const action = stringValue(event.action);
  if (action !== "started" && action !== "finished") return null;
  const jobId = stringValue(event.jobId);
  if (!jobId) return null;
  const identity = runIdentity(event);
  const current = await resolveCurrentFacts(jobId, event, ctx);
  const runKey = identity ? `${jobId}\n${identity}` : undefined;

  if (action === "started") {
    if (runKey) {
      factsByRun.delete(runKey);
      factsByRun.set(runKey, current);
      while (factsByRun.size > MAX_PENDING_RUN_FACTS) {
        const oldest = factsByRun.keys().next().value;
        if (!oldest) break;
        factsByRun.delete(oldest);
      }
    }
    return null;
  }

  const carried = runKey ? factsByRun.get(runKey) : undefined;
  if (runKey) factsByRun.delete(runKey);
  const facts: CronRunFacts = {
    delivery:
      carried && carried.delivery.deliversToFridayNext !== null
        ? carried.delivery
        : current.delivery,
    jobName: current.jobName ?? carried?.jobName,
    agentId: current.agentId ?? carried?.agentId,
  };

  // 严格拒绝 unknown、默认目标和其他设备；只有显式 friday-next + to 才能生成历史。
  const deviceId = facts.delivery.to;
  if (facts.delivery.deliversToFridayNext !== true || !deviceId) {
    logger.warn(
      `[CRON_RESULT_REJECTED] jobId=${jobId} reason=unconfirmed-device-target toFriday=${facts.delivery.deliversToFridayNext ?? "unknown"} to=${deviceId ?? "(none)"}`,
    );
    return null;
  }
  if (!identity) {
    logger.warn(`[CRON_RESULT_REJECTED] jobId=${jobId} reason=missing-run-identity`);
    return null;
  }

  clearLegacyNotificationLogOnce();
  const runAtMs = finiteNumber(event.runAtMs);
  const durationMs = finiteNumber(event.durationMs);
  const status = stringValue(event.status) ?? stringValue(event.completionStatus) ?? "unknown";
  const record = cronResultStore.append({
    sourceIdentity: identity,
    category: "cronResults",
    kind: "cronResult",
    lifecycle: "event",
    occurredAtMs: runAtMs === undefined ? Date.now() : runAtMs + (durationMs ?? 0),
    deviceId,
    jobId,
    ...(facts.jobName ? { jobName: facts.jobName } : {}),
    agentId: facts.agentId ?? "main",
    ...(stringValue(event.runId) ? { runId: stringValue(event.runId) } : {}),
    ...(stringValue(event.sessionId) ? { sessionId: stringValue(event.sessionId) } : {}),
    ...(runAtMs === undefined ? {} : { runAtMs }),
    ...(durationMs === undefined ? {} : { durationMs }),
    status,
    ...(stringValue(event.completionStatus)
      ? { completionStatus: stringValue(event.completionStatus) }
      : {}),
    ...(stringValue(event.summary) ? { summary: stringValue(event.summary) } : {}),
    ...(stringValue(event.error) ? { error: stringValue(event.error) } : {}),
    ...(optionalBoolean(event.delivered) === undefined
      ? {}
      : { delivered: optionalBoolean(event.delivered) }),
    ...(stringValue(event.deliveryStatus)
      ? { deliveryStatus: stringValue(event.deliveryStatus) }
      : {}),
    ...(stringValue(event.deliveryError)
      ? { deliveryError: stringValue(event.deliveryError) }
      : {}),
    ...(stringValue(event.deliverySuppressionReason)
      ? { deliverySuppressionReason: stringValue(event.deliverySuppressionReason) }
      : {}),
  });
  if (record) {
    logger.info(
      `[CRON_RESULT_CAPTURED] jobId=${jobId} cursor=${record.cursor} device=${deviceId} status=${status}`,
    );
  }
  return record;
}

export function resetCronResultCaptureForTest(): void {
  factsByRun.clear();
}
