// Friday Next exec/plugin approval capability.
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

const logger = createFridayNextLogger("approval");

/** SSE payload the app receives for an approval lifecycle event. `op` is the phase. */
export interface FridayApprovalPayload {
  op: "request" | "resolved" | "expired";
  approvalId: string;
  kind: "exec" | "plugin";
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
  metadata: { label: string; value: string }[];
  actions: { decision: string; label: string; style: string }[];
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
}

/** Pull the originating sessionKey out of an exec/plugin approval request (`request.request.*`). */
function sessionKeyOf(request: unknown): string | undefined {
  const inner = (request as { request?: { sessionKey?: unknown } } | undefined)?.request;
  const sk = inner?.sessionKey;
  return typeof sk === "string" && sk.trim() ? sk.trim() : undefined;
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
  return {
    op,
    approvalId: str(view.approvalId) ?? "",
    kind: view.approvalKind === "plugin" ? "plugin" : "exec",
    title: str(view.title) ?? "",
    description: str(view.description),
    commandText: str(view.commandText),
    commandPreview: str(view.commandPreview),
    cwd: str(view.cwd),
    host: str(view.host),
    toolName: str(view.toolName),
    severity: str(view.severity),
    metadata: metaRaw.map((m) => ({ label: str(m.label) ?? "", value: str(m.value) ?? "" })),
    actions: actionsRaw.map((a) => ({
      decision: str(a.decision) ?? "",
      label: str(a.label) ?? "",
      style: str(a.style) ?? "secondary",
    })),
    expiresAtMs: num(view.expiresAtMs),
    decision: str(view.decision),
    resolvedBy: str(view.resolvedBy),
    sessionKey: sessionKeyOf(request) ?? null,
    runId: sseEmitter.getLastRunIdForDevice(deviceId),
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
  eventKinds: ["exec", "plugin"],
  availability: {
    isConfigured: () => true,
    shouldHandle: ({ request }) => deviceForRequest(request) !== undefined,
  },
  presentation: {
    buildPendingPayload: ({ request, view }) => {
      const deviceId = deviceForRequest(request) ?? "";
      return buildPayload({
        op: "request",
        view: view as unknown as Record<string, unknown>,
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
          view: view as unknown as Record<string, unknown>,
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
          view: view as unknown as Record<string, unknown>,
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
      logger.info(`deliver approval ${pendingPayload.approvalId} kind=${pendingPayload.kind} -> ${deviceId}`);
      emitApproval(deviceId, { ...pendingPayload, deviceId });
      return { deviceId, approvalId: pendingPayload.approvalId };
    },
    updateEntry: async ({ entry, payload }) => {
      emitApproval(entry.deviceId, { ...payload, deviceId: entry.deviceId });
    },
    deleteEntry: async ({ entry, phase }) => {
      emitApproval(entry.deviceId, {
        op: phase === "resolved" ? "resolved" : "expired",
        approvalId: entry.approvalId,
        kind: "exec",
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
      const enabled = deviceForRequest(request) !== undefined;
      return {
        enabled,
        preferredSurface: "origin",
        supportsOriginSurface: true,
        supportsApproverDmSurface: false,
      };
    },
    resolveOriginTarget: ({ request }) => {
      const deviceId = deviceForRequest(request);
      return deviceId ? { to: deviceId } : null;
    },
  },
  // Cast widens the parameterized adapter to the field's `unknown`-typed shape (function-param
  // contravariance). Same escape hatch Slack uses for its lazy runtime adapter.
  nativeRuntime: fridayApprovalNativeRuntime as unknown as ChannelApprovalCapability["nativeRuntime"],
};
