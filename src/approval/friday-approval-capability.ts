// Friday Next exec/plugin/system-agent approval capability.
//
// Lets the Friday app receive tool-execution approval REQUESTS (e.g. a Codex model wanting to run a
// shell command that needs confirmation) and submit allow/deny DECISIONS — instead of those
// approvals only reaching the gateway's built-in ControlUI.
//
// Model: unlike Slack (a separate approver list authorized per-account), friday-next uses a
// device-owner model — the device that owns the originating session is the approver. HTTP requests
// already carry the channel bearer token, so per-sender authorization happens at the route layer;
// here we only resolve WHICH device a request belongs to (its session's device) and deliver the
// prompt there over SSE. The decision round-trips via POST /friday-next/approvals/{id}.
//
// We intentionally do NOT set a `delivery.shouldSuppressForwardingFallback` adapter, so enabling
// this stays additive: ControlUI keeps working as a fallback while the app surface is the primary.

import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import { sseEmitter } from "../sse/emitter.js";
import { resolveFridayDeviceIdForSessionKey } from "../friday-session.js";
import { createFridayNextLogger } from "../logging.js";
import { runtimeV3StoreIfInitialized } from "../runtime-v3/runtime-store.js";
import { legacyApprovalStore } from "../inbox/legacy-approval-store.js";

const logger = createFridayNextLogger("approval");

/** SSE payload the app receives for an approval lifecycle event. `op` is the phase. */
export interface FridayApprovalPayload {
  op: "request" | "resolved" | "expired";
  approvalId: string;
  kind: "exec" | "plugin" | "system-agent";
  title: string;
  description?: string | null;
  // exec
  commandText?: string | null;
  commandPreview?: string | null;
  cwd?: string | null;
  host?: string | null;
  // plugin
  toolName?: string | null;
  severity?: string | null;
  proposalHash?: string | null;
  agentId?: string | null;
  metadata: { label: string; value: string }[];
  actions: { decision: string; label: string; style: string }[];
  createdAtMs?: number | null;
  expiresAtMs?: number | null;
  decision?: string | null;
  resolvedBy?: string | null;
  sessionKey?: string | null;
  runId?: string | null;
  deviceId: string;
  ts: number;
}

interface PreparedTarget {
  deviceId: string;
}
interface PendingEntry {
  deviceId: string;
  approvalId: string;
  kind: FridayApprovalPayload["kind"];
}

const GLOBAL_INBOX_TARGET = "__FRIDAY_INBOX_ALL__";

function emitInboxInvalidation(): void {
  sseEmitter.broadcastLive({ type: "inbox-changed", data: {} }, true);
}

/** Pull the originating sessionKey out of an exec/plugin approval request (`request.request.*`). */
function sessionKeyOf(request: unknown): string | undefined {
  const inner = (request as { request?: { sessionKey?: unknown } } | undefined)?.request;
  const sk = inner?.sessionKey;
  return typeof sk === "string" && sk.trim() ? sk.trim() : undefined;
}

function runIdOf(
  request: unknown,
  sessionKey: string | undefined,
  deviceId: string,
): string | undefined {
  const inner = (request as { request?: { runId?: unknown } } | undefined)?.request;
  if (typeof inner?.runId === "string" && inner.runId.trim()) return inner.runId.trim();
  if (!sessionKey) return undefined;
  return runtimeV3StoreIfInitialized()?.activeRunForSession(sessionKey, deviceId)?.runId;
}

/** Resolve the friday device that owns this approval's session, if any. */
function deviceForRequest(request: unknown): string | undefined {
  const sk = sessionKeyOf(request);
  if (!sk) return undefined;
  const dev = resolveFridayDeviceIdForSessionKey(sk);
  return dev ? dev.toUpperCase() : undefined;
}

/** Build the normalized app payload from a pending/resolved/expired approval view. */
export function buildPayload(params: {
  op: FridayApprovalPayload["op"];
  view: Record<string, unknown>;
  request: unknown;
  deviceId: string;
}): FridayApprovalPayload {
  const { op, view, request, deviceId } = params;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const actionsRaw = Array.isArray(view.actions) ? (view.actions as Record<string, unknown>[]) : [];
  const metaRaw = Array.isArray(view.metadata) ? (view.metadata as Record<string, unknown>[]) : [];
  const sessionKey = sessionKeyOf(request);
  const envelope = request as
    | { request?: Record<string, unknown>; createdAtMs?: unknown; expiresAtMs?: unknown }
    | undefined;
  const inner = envelope?.request;
  const kind =
    view.approvalKind === "plugin"
      ? "plugin"
      : view.approvalKind === "system-agent"
        ? "system-agent"
        : "exec";
  return {
    op,
    approvalId: str(view.approvalId) ?? "",
    kind,
    title:
      kind === "system-agent"
        ? (str(inner?.title) ?? str(view.title) ?? "")
        : (str(view.title) ?? ""),
    description:
      kind === "system-agent"
        ? (str(inner?.description) ?? str(view.description))
        : str(view.description),
    commandText:
      kind === "system-agent"
        ? (str(inner?.command) ?? str(view.commandText))
        : str(view.commandText),
    commandPreview: str(view.commandPreview),
    cwd: str(view.cwd),
    host: str(view.host),
    toolName: str(view.toolName),
    severity: str(view.severity),
    proposalHash: str(inner?.proposalHash),
    agentId: str(inner?.agentId),
    metadata: metaRaw.map((m) => ({ label: str(m.label) ?? "", value: str(m.value) ?? "" })),
    actions: actionsRaw.map((a) => ({
      decision: str(a.decision) ?? "",
      label: str(a.label) ?? "",
      style: str(a.style) ?? "secondary",
    })),
    createdAtMs: num(envelope?.createdAtMs),
    expiresAtMs: num(view.expiresAtMs) ?? num(envelope?.expiresAtMs),
    decision: str(view.decision),
    resolvedBy: str(view.resolvedBy),
    sessionKey: sessionKey ?? null,
    runId: runIdOf(request, sessionKey, deviceId) ?? null,
    deviceId,
    ts: Date.now(),
  };
}

function emitApproval(deviceId: string, payload: FridayApprovalPayload): void {
  sseEmitter.broadcast({ type: "approval", data: { ...payload } }, deviceId, true);
}

const fridayApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  FridayApprovalPayload,
  PreparedTarget,
  PendingEntry,
  never,
  FridayApprovalPayload
>({
  eventKinds: ["exec", "plugin", "system-agent"],
  availability: {
    isConfigured: () => true,
    // 全局审批快照属于设备 owner 收件箱，即使审批不是由 Friday 会话发起也必须监听。
    shouldHandle: () => true,
  },
  presentation: {
    buildPendingPayload: ({ request, view }) => {
      const deviceId = deviceForRequest(request) ?? "";
      return buildPayload({
        op: "request",
        view: view as Record<string, unknown>,
        request,
        deviceId,
      });
    },
    buildResolvedResult: ({ request, view }) => {
      const deviceId = deviceForRequest(request) ?? "";
      return {
        kind: "update",
        payload: buildPayload({
          op: "resolved",
          view: view as Record<string, unknown>,
          request,
          deviceId,
        }),
      };
    },
    buildExpiredResult: ({ request, view }) => {
      const deviceId = deviceForRequest(request) ?? "";
      return {
        kind: "update",
        payload: buildPayload({
          op: "expired",
          view: view as Record<string, unknown>,
          request,
          deviceId,
        }),
      };
    },
  },
  transport: {
    prepareTarget: ({ plannedTarget, request }) => {
      const planned =
        typeof plannedTarget?.target?.to === "string" && plannedTarget.target.to.trim()
          ? plannedTarget.target.to.trim().toUpperCase()
          : undefined;
      const deviceId = planned ?? deviceForRequest(request);
      if (!deviceId) return null;
      return { dedupeKey: `friday-approval:${deviceId}`, target: { deviceId } };
    },
    deliverPending: ({ preparedTarget, pendingPayload }) => {
      const deviceId = preparedTarget.deviceId;
      legacyApprovalStore.upsert({ ...pendingPayload, deviceId });
      emitInboxInvalidation();
      if (deviceId === GLOBAL_INBOX_TARGET) {
        return { deviceId, approvalId: pendingPayload.approvalId, kind: pendingPayload.kind };
      }
      logger.info(
        `deliver approval ${pendingPayload.approvalId} kind=${pendingPayload.kind} -> ${deviceId}`,
      );
      emitApproval(deviceId, { ...pendingPayload, deviceId });
      return { deviceId, approvalId: pendingPayload.approvalId, kind: pendingPayload.kind };
    },
    updateEntry: async ({ entry, payload }) => {
      legacyApprovalStore.remove(payload.kind, payload.approvalId || entry.approvalId);
      emitInboxInvalidation();
      if (entry.deviceId !== GLOBAL_INBOX_TARGET) {
        emitApproval(entry.deviceId, { ...payload, deviceId: entry.deviceId });
      }
    },
    deleteEntry: async ({ entry, phase }) => {
      legacyApprovalStore.remove(entry.kind, entry.approvalId);
      emitInboxInvalidation();
      if (entry.deviceId === GLOBAL_INBOX_TARGET) return;
      emitApproval(entry.deviceId, {
        op: phase === "resolved" ? "resolved" : "expired",
        approvalId: entry.approvalId,
        kind: entry.kind,
        title: "",
        metadata: [],
        actions: [],
        deviceId: entry.deviceId,
        ts: Date.now(),
      });
    },
  },
  observe: {
    onDeliveryError: ({ error }) => {
      logger.warn(`approval delivery failed: ${String(error)}`);
    },
  },
});

/**
 * friday-next approval capability. `native` declares delivery to the originating device's session;
 * `nativeRuntime` builds the app payload and ferries it over SSE. No `delivery` suppressor → additive
 * with ControlUI.
 */
export const fridayApprovalCapability: ChannelApprovalCapability = {
  native: {
    describeDeliveryCapabilities: ({ request }) => {
      const hasOrigin = deviceForRequest(request) !== undefined;
      return {
        enabled: true,
        preferredSurface: "origin",
        supportsOriginSurface: hasOrigin,
        // 没有 Friday 来源设备时，以内部哨兵保持生命周期监听，仅发送无载荷失效通知。
        supportsApproverDmSurface: true,
      };
    },
    resolveOriginTarget: ({ request }) => {
      const deviceId = deviceForRequest(request);
      return deviceId ? { to: deviceId } : null;
    },
    resolveApproverDmTargets: () => [{ to: GLOBAL_INBOX_TARGET }],
  },
  // The field is `unknown`-typed, so the parameterized adapter assigns directly — the widening
  // happens at the field boundary (function-param contravariance), no cast needed.
  nativeRuntime: fridayApprovalNativeRuntime,
};
