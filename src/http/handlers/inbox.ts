import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { verifySession } from "../../attest/attest-store.js";
import { attestGateDecision, ATTEST_REJECTION_BODY } from "../../attest/attest-gate.js";
import { normalizeAgentId } from "../../agent-id.js";
import { resolveApprovalViaGateway } from "../../approval/approval-resolution.js";
import { resolveFridayNextConfig } from "../../config.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import {
  projectApprovals,
  projectAutomationAttention,
  projectModelAuthAttention,
  projectUpdateAttention,
  type InboxAttentionItem,
} from "../../inbox/attention-projection.js";
import { clearLegacyNotificationLogOnce, cronResultStore } from "../../inbox/cron-result-store.js";
import { legacyApprovalStore, type LegacyApprovalKind } from "../../inbox/legacy-approval-store.js";
import { getFridayNextRuntime } from "../../runtime.js";
import { getRuntimeV3Store } from "../../runtime-v3/runtime-store.js";
import { sseEmitter } from "../../sse/emitter.js";
import { readJsonBody } from "../middleware/body.js";
import { isPublicRequest } from "../middleware/public-surface.js";

const CONTROL_UI_PARITY_VERSION = "2026.9.4";
const PAGE_SIZE = 200;
const MAX_CRON_PAGES = 100;
const VALID_DECISIONS = new Set(["allow-once", "allow-always", "deny"]);
let lastRevision = 0;

type GatewayReply = Awaited<ReturnType<typeof dispatchGatewayMethod>>;
type SourceState = {
  status: "fresh" | "stale" | "unsupported";
  fetchedAtMs: number;
  detail?: string;
};

function json(res: ServerResponse, status: number, body: Record<string, unknown>): true {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
  return true;
}

function applyPublicAttestGate(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isPublicRequest(req)) return false;
  const cfg = resolveFridayNextConfig(getHostOpenClawConfigSnapshot(getFridayNextRuntime().config));
  const rejected =
    attestGateDecision({
      pathname: "/friday-next-admin/inbox",
      headers: req.headers,
      isPublic: true,
      required: cfg.appAttest.required,
      scope: "plugin",
      verify: (token) => verifySession(token, Date.now()),
    }) === "reject";
  if (rejected) json(res, 403, { ...ATTEST_REJECTION_BODY });
  return rejected;
}

async function requestGateway(method: string, params: Record<string, unknown>): Promise<unknown> {
  let response: GatewayReply;
  try {
    response = await dispatchGatewayMethod(method, params);
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(String(error), { cause: error });
  }
  if (!response.ok) {
    const code = response.error?.code;
    throw Object.assign(new Error(response.error?.message ?? `${method} failed`), {
      code,
      gatewayError: response.error,
    });
  }
  return response.payload;
}

function isUnknownGatewayMethod(error: unknown, method: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  const escapedMethod = method.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    ((code === "UNKNOWN_METHOD" || code === "METHOD_NOT_FOUND" || code === "INVALID_REQUEST") &&
      new RegExp(`unknown method:\\s*${escapedMethod}(?:\\s|$)`, "i").test(error.message)) ||
    new RegExp(`^unknown method:\\s*${escapedMethod}(?:\\s|$)`, "i").test(error.message)
  );
}

async function listApprovalsWithLegacyFallback(
  method: string,
  kind: LegacyApprovalKind,
): Promise<unknown> {
  try {
    return await requestGateway(method, {});
  } catch (error) {
    if (!isUnknownGatewayMethod(error, method)) throw error;
    // COMPAT(openclaw<=2026.7.1 approval-list-rpc): 旧版没有三套 pending-list RPC，
    // 只在方法明确不存在时读取 approval capability 的结构化持久镜像。
    // CLEANUP: 最低宿主版本高于 2026.7.1 后删除该回退和 legacyApprovalStore。
    return legacyApprovalStore.list(kind);
  }
}

function sourceState(
  result: PromiseSettledResult<unknown>,
  fetchedAtMs: number,
  validate: (value: unknown) => boolean = () => true,
): SourceState {
  if (result.status === "fulfilled" && validate(result.value)) {
    return { status: "fresh", fetchedAtMs };
  }
  return {
    status: "stale",
    fetchedAtMs,
    detail:
      result.status === "rejected"
        ? result.reason instanceof Error
          ? result.reason.message
          : String(result.reason)
        : "gateway returned an invalid response",
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isLegacyCronListDeliveryPreviewError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    code === "INVALID_REQUEST" &&
    /cron\.list params/i.test(error.message) &&
    /unexpected property ['"]includeDeliveryPreviews['"]/i.test(error.message)
  );
}

async function listAllCronJobs(agentId?: string): Promise<unknown[]> {
  const jobs: unknown[] = [];
  for (let page = 0; page < MAX_CRON_PAGES; page += 1) {
    const params = {
      includeDisabled: true,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      ...(agentId ? { agentId } : {}),
    };
    let response: unknown;
    try {
      response = await requestGateway("cron.list", {
        ...params,
        includeDeliveryPreviews: false,
      });
    } catch (error) {
      if (!isLegacyCronListDeliveryPreviewError(error)) throw error;
      // COMPAT(openclaw<=2026.7.1 cron-list-delivery-preview-param): 旧版 schema 不认识
      // includeDeliveryPreviews，只在精确命中该校验错误时使用旧参数集重试。
      // CLEANUP: 最低宿主版本高于 2026.7.1 且旧版测试床退役后删除此分支及对应测试。
      response = await requestGateway("cron.list", params);
    }
    const payload = object(response);
    if (!Array.isArray(payload.jobs)) throw new Error("cron.list returned an invalid response");
    const rows = payload.jobs;
    jobs.push(...rows);
    const total = typeof payload.total === "number" ? payload.total : undefined;
    if (rows.length < PAGE_SIZE || (total !== undefined && jobs.length >= total)) return jobs;
  }
  throw new Error("cron.list pagination exceeded safety limit");
}

function approvalList(value: unknown): boolean {
  return Array.isArray(value);
}

function cronStatusPayload(value: unknown): boolean {
  return typeof object(value).enabled === "boolean";
}

function modelAuthPayload(value: unknown): boolean {
  return Array.isArray(object(value).providers);
}

function updateStatusPayload(value: unknown): boolean {
  const payload = object(value);
  // COMPAT(openclaw<=2026.7.1 update-status-sentinel-only): 旧版 update.status 的完整契约
  // 只有 sentinel；新版才加入 updateAvailable/activeRun/lastRun/schedule。
  // CLEANUP: 最低宿主版本高于 2026.7.1 后移除 sentinel-only 接受路径及对应测试。
  return ["updateAvailable", "activeRun", "lastRun", "schedule", "sentinel"].some((key) =>
    Object.hasOwn(payload, key),
  );
}

function nextRevision(nowMs: number): number {
  lastRevision = Math.max(nowMs, lastRevision + 1);
  return lastRevision;
}

async function handleSnapshot(req: IncomingMessage, res: ServerResponse): Promise<true> {
  if (req.method !== "GET") return json(res, 405, { error: "Method Not Allowed" });
  const url = new URL(req.url ?? "/", "http://localhost");
  const deviceId = (url.searchParams.get("deviceId") ?? "").trim().toUpperCase();
  if (!deviceId) return json(res, 400, { error: "Missing deviceId" });
  const rawAgentId = (url.searchParams.get("agentId") ?? "").trim();
  const agentId = normalizeAgentId(rawAgentId || "main");
  const parsedCursor = Number(url.searchParams.get("afterCursor") ?? "0");
  const afterCursor = Number.isSafeInteger(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
  const fetchedAtMs = Date.now();
  clearLegacyNotificationLogOnce();
  let cronResults: ReturnType<typeof cronResultStore.readAfter> = [];
  let cronCursor = afterCursor;
  let cronResultSource: SourceState = { status: "fresh", fetchedAtMs };
  try {
    cronResults = cronResultStore.readAfter(deviceId, afterCursor);
    cronCursor = Math.max(afterCursor, cronResultStore.currentCursor(deviceId));
  } catch (error) {
    cronResultSource = {
      status: "stale",
      fetchedAtMs,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const serverInstanceId = getRuntimeV3Store().serverInstanceId;

  const [exec, plugin, systemAgent, cronJobs, cronStatus, modelAuth, update] =
    await Promise.allSettled([
      listApprovalsWithLegacyFallback("exec.approval.list", "exec"),
      listApprovalsWithLegacyFallback("plugin.approval.list", "plugin"),
      listApprovalsWithLegacyFallback("openclaw.approval.list", "system-agent"),
      listAllCronJobs(),
      requestGateway("cron.status", {}),
      requestGateway("models.authStatus", { agentId }),
      requestGateway("update.status", {}),
    ]);

  const execFresh = exec.status === "fulfilled" && approvalList(exec.value);
  const pluginFresh = plugin.status === "fulfilled" && approvalList(plugin.value);
  const systemAgentFresh = systemAgent.status === "fulfilled" && approvalList(systemAgent.value);
  const cronStatusFresh = cronStatus.status === "fulfilled" && cronStatusPayload(cronStatus.value);
  const modelAuthFresh = modelAuth.status === "fulfilled" && modelAuthPayload(modelAuth.value);
  const updateFresh = update.status === "fulfilled" && updateStatusPayload(update.value);
  const approvals = projectApprovals(
    {
      ...(execFresh ? { exec: exec.value } : {}),
      ...(pluginFresh ? { plugin: plugin.value } : {}),
      ...(systemAgentFresh ? { "system-agent": systemAgent.value } : {}),
    },
    fetchedAtMs,
  );
  const statusPayload = cronStatus.status === "fulfilled" ? object(cronStatus.value) : {};
  const automations = projectAutomationAttention({
    jobs: cronJobs.status === "fulfilled" ? cronJobs.value : [],
    schedulerEnabled:
      cronStatusFresh && typeof statusPayload.enabled === "boolean" ? statusPayload.enabled : null,
    nowMs: fetchedAtMs,
  });
  const system: InboxAttentionItem[] = [
    ...(modelAuthFresh ? projectModelAuthAttention(modelAuth.value, agentId, fetchedAtMs) : []),
    ...(updateFresh ? projectUpdateAttention(update.value, serverInstanceId, fetchedAtMs) : []),
  ];

  return json(res, 200, {
    ok: true,
    schemaVersion: 2,
    serverInstanceId,
    controlUiParityVersion: CONTROL_UI_PARITY_VERSION,
    revision: nextRevision(fetchedAtMs),
    cursor: cronCursor,
    cronResults,
    attention: { approvals, automations, system },
    sources: {
      cronResults: cronResultSource,
      execApprovals: sourceState(exec, fetchedAtMs, approvalList),
      pluginApprovals: sourceState(plugin, fetchedAtMs, approvalList),
      systemAgentApprovals: sourceState(systemAgent, fetchedAtMs, approvalList),
      cronJobs: sourceState(cronJobs, fetchedAtMs),
      cronStatus: sourceState(cronStatus, fetchedAtMs, cronStatusPayload),
      modelAuth: sourceState(modelAuth, fetchedAtMs, modelAuthPayload),
      update: sourceState(update, fetchedAtMs, updateStatusPayload),
      scopeUpgrade: {
        status: "unsupported",
        fetchedAtMs,
        detail: "Friday HTTP bearer transport has no device scope-upgrade state",
      },
    },
  });
}

function approvalKind(value: unknown): "exec" | "plugin" | "system-agent" | undefined {
  if (value === "exec" || value === "plugin" || value === "system-agent") return value;
  return undefined;
}

async function handleResolve(req: IncomingMessage, res: ServerResponse): Promise<true> {
  if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });
  const body = await readJsonBody(req);
  if (!body) return json(res, 400, { error: "Invalid JSON body" });
  const kind = approvalKind(body.kind);
  const decision = typeof body.decision === "string" ? body.decision.trim() : "";
  const approvalId = typeof body.approvalId === "string" ? body.approvalId : "";
  if (!kind) return json(res, 400, { error: "kind must be exec | plugin | system-agent" });
  if (!VALID_DECISIONS.has(decision)) {
    return json(res, 400, { error: "decision must be allow-once | allow-always | deny" });
  }
  if (kind === "system-agent" && decision === "allow-always") {
    return json(res, 400, { error: "system-agent decision must be allow-once | deny" });
  }
  if (!approvalId) return json(res, 400, { error: "Missing approvalId" });
  const method =
    kind === "exec"
      ? "exec.approval.resolve"
      : kind === "plugin"
        ? "plugin.approval.resolve"
        : "approval.resolve";
  try {
    await requestGateway(method, {
      id: approvalId,
      decision,
      ...(kind === "system-agent" ? { kind } : {}),
    });
  } catch (nativeError) {
    let resolutionError = nativeError;
    if (isUnknownGatewayMethod(nativeError, method)) {
      try {
        // COMPAT(openclaw<=2026.7.1 approval-resolve-rpc): 旧版没有按 kind 拆分的 resolve
        // RPC，使用其 SDK 提供的统一 resolver；新版始终走上面的原生方法。
        // CLEANUP: 最低宿主版本高于 2026.7.1 后删除此分支及对应测试。
        await resolveApprovalViaGateway({
          cfg: getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
          approvalId,
          decision: decision as "allow-once" | "allow-always" | "deny",
          allowPluginFallback: true,
          clientDisplayName: "Friday Next",
        });
        legacyApprovalStore.remove(kind, approvalId);
        sseEmitter.broadcastLive({ type: "inbox-changed", data: {} }, true);
        return json(res, 200, { ok: true, approvalId, kind, decision });
      } catch (fallbackError) {
        resolutionError = fallbackError;
      }
    }
    const gatewayError = object((resolutionError as { gatewayError?: unknown }).gatewayError);
    const details = object(gatewayError.details);
    const code = (resolutionError as { code?: unknown }).code;
    const reason = typeof details.reason === "string" ? details.reason : undefined;
    const stale =
      code === "APPROVAL_ALREADY_RESOLVED" ||
      code === "APPROVAL_NOT_FOUND" ||
      reason === "APPROVAL_ALREADY_RESOLVED" ||
      reason === "APPROVAL_NOT_FOUND" ||
      (resolutionError instanceof Error &&
        /approval (?:not found|already resolved)|unknown or expired approval id/i.test(
          resolutionError.message,
        ));
    if (!stale) {
      return json(res, 502, {
        ok: false,
        error: resolutionError instanceof Error ? resolutionError.message : String(resolutionError),
        ...(typeof code === "string" ? { code } : {}),
      });
    }
  }
  legacyApprovalStore.remove(kind, approvalId);
  sseEmitter.broadcastLive({ type: "inbox-changed", data: {} }, true);
  return json(res, 200, { ok: true, approvalId, kind, decision });
}

async function handleCronResultDelete(
  req: IncomingMessage,
  res: ServerResponse,
  cursorRaw: string,
): Promise<true> {
  if (req.method !== "DELETE") return json(res, 405, { error: "Method Not Allowed" });
  const url = new URL(req.url ?? "/", "http://localhost");
  const deviceId = (url.searchParams.get("deviceId") ?? "").trim().toUpperCase();
  if (!deviceId) return json(res, 400, { error: "Missing deviceId" });
  const cursor = Number(cursorRaw);
  if (!Number.isSafeInteger(cursor)) return json(res, 400, { error: "Invalid cursor" });
  return json(res, 200, { ok: true, deleted: cronResultStore.delete(deviceId, cursor) });
}

export async function handleInbox(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (applyPublicAttestGate(req, res)) return true;
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname === "/friday-next-admin/inbox/snapshot") return handleSnapshot(req, res);
  if (pathname === "/friday-next-admin/inbox/approvals/resolve") {
    return handleResolve(req, res);
  }
  const cronResultMatch = pathname.match(/^\/friday-next-admin\/inbox\/cron-results\/(\d+)$/);
  if (cronResultMatch?.[1]) return handleCronResultDelete(req, res, cronResultMatch[1]);
  return json(res, 404, { error: "Not Found" });
}
