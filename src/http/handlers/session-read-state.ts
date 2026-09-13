/**
 * GET|PATCH /friday-next-admin/sessions/state
 *
 * Friday 对 OpenClaw 原生会话未读状态的窄适配层。GET 只投影
 * `sessions.list` 的阅读/运行字段；PATCH 把已读/未读写入交给
 * `sessions.patch`，因此时间戳、未读推导和过期确认均由 Gateway 负责。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { verifySession } from "../../attest/attest-store.js";
import { attestGateDecision, ATTEST_REJECTION_BODY } from "../../attest/attest-gate.js";
import { resolveFridayNextConfig } from "../../config.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { getFridayNextRuntime } from "../../runtime.js";
import { readJsonBody } from "../middleware/body.js";
import { isPublicRequest } from "../middleware/public-surface.js";

const PAGE_SIZE = 250;
const MAX_RECONCILIATION_PASSES = 4;
const MAX_PAGES_PER_PASS = 100;

type GatewayResponse = Awaited<ReturnType<typeof dispatchGatewayMethod>>;

interface GatewaySessionListPage {
  totalCount?: number;
  nextOffset?: number | null;
  hasMore?: boolean;
  sessions?: unknown[];
}

function json(res: ServerResponse, status: number, body: Record<string, unknown>): true {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
  return true;
}

function statusForErrorCode(code: string | undefined): number {
  switch (code) {
    case "INVALID_REQUEST":
      return 400;
    case "FORBIDDEN":
      return 403;
    case "NOT_LINKED":
    case "NOT_PAIRED":
      return 409;
    case "UNAVAILABLE":
      return 503;
    case "AGENT_TIMEOUT":
      return 504;
    default:
      return 500;
  }
}

function gatewayFailure(res: ServerResponse, response: GatewayResponse, method: string): true {
  const code = response.error?.code;
  return json(res, statusForErrorCode(code), {
    ok: false,
    error: response.error?.message ?? `${method} failed`,
    ...(code ? { code } : {}),
  });
}

function applyPublicAttestGate(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isPublicRequest(req)) return false;
  const attestCfg = resolveFridayNextConfig(
    getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
  );
  const gate = attestGateDecision({
    pathname: "/friday-next-admin/sessions/state",
    headers: req.headers,
    isPublic: true,
    required: attestCfg.appAttest.required,
    scope: "plugin",
    verify: (token) => verifySession(token, Date.now()),
  });
  if (gate !== "reject") return false;
  json(res, 403, { ...ATTEST_REJECTION_BODY });
  return true;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 只输出 App 展示/确认已读所需字段，避免把完整会话行和潜在扩展数据外泄。 */
function projectReadState(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const sessionKey = nonEmptyString(row.key);
  if (!sessionKey) return null;

  const state: Record<string, unknown> = { sessionKey };
  const strings = ["agentId", "sessionId", "status", "lastRunError"] as const;
  const numbers = [
    "createdAt",
    "updatedAt",
    "lastReadAt",
    "markedUnreadAt",
    "lastActivityAt",
    "lastInteractionAt",
  ] as const;
  for (const key of strings) {
    const field = nonEmptyString(row[key]);
    if (field !== undefined) state[key] = field;
  }
  for (const key of numbers) {
    const field = finiteNumber(row[key]);
    if (field !== undefined) state[key] = field;
  }
  if (typeof row.unread === "boolean") state.unread = row.unread;
  if (typeof row.hasActiveRun === "boolean") state.hasActiveRun = row.hasActiveRun;
  return state;
}

async function listReadStates(
  res: ServerResponse,
): Promise<{ states: Record<string, unknown>[]; complete: boolean } | true> {
  const statesByKey = new Map<string, Record<string, unknown>>();
  let expectedTotal: number | undefined;

  for (let pass = 0; pass < MAX_RECONCILIATION_PASSES; pass += 1) {
    const rowsBeforePass = statesByKey.size;
    const seenOffsets = new Set<number>();
    let offset = 0;
    let pageCount = 0;
    while (!seenOffsets.has(offset) && pageCount < MAX_PAGES_PER_PASS) {
      seenOffsets.add(offset);
      pageCount += 1;
      let response: GatewayResponse;
      try {
        response = await dispatchGatewayMethod("sessions.list", {
          configuredAgentsOnly: true,
          includeGlobal: false,
          includeUnknown: false,
          limit: PAGE_SIZE,
          offset,
        });
      } catch (error) {
        return json(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!response.ok) return gatewayFailure(res, response, "sessions.list");

      const payload = (response.payload ?? {}) as GatewaySessionListPage;
      const rows = Array.isArray(payload.sessions) ? payload.sessions : [];
      if (typeof payload.totalCount === "number" && Number.isFinite(payload.totalCount)) {
        expectedTotal = Math.max(expectedTotal ?? 0, payload.totalCount);
      }
      for (const row of rows) {
        const state = projectReadState(row);
        if (state) statesByKey.set(String(state.sessionKey).toLowerCase(), state);
      }

      const hasMore =
        payload.hasMore ?? (expectedTotal !== undefined && offset + rows.length < expectedTotal);
      if (!hasMore) break;
      const nextOffset = finiteNumber(payload.nextOffset) ?? offset + rows.length;
      if (nextOffset <= offset) break;
      offset = nextOffset;
    }

    if (
      statesByKey.size === rowsBeforePass ||
      expectedTotal === undefined ||
      statesByKey.size >= expectedTotal
    ) {
      break;
    }
  }

  return {
    states: [...statesByKey.values()],
    complete: expectedTotal === undefined || statesByKey.size >= expectedTotal,
  };
}

async function patchReadState(req: IncomingMessage, res: ServerResponse): Promise<true> {
  const body = await readJsonBody(req);
  const sessionKey = nonEmptyString(body?.sessionKey);
  if (!sessionKey) return json(res, 400, { error: "Missing required field: sessionKey" });
  if (typeof body?.unread !== "boolean") {
    return json(res, 400, { error: "unread must be a boolean" });
  }

  const markerWasProvided = Object.prototype.hasOwnProperty.call(body, "expectedMarkedUnreadAt");
  if (
    markerWasProvided &&
    body?.expectedMarkedUnreadAt !== null &&
    finiteNumber(body?.expectedMarkedUnreadAt) === undefined
  ) {
    return json(res, 400, { error: "expectedMarkedUnreadAt must be a number or null" });
  }

  const agentId = nonEmptyString(body?.agentId);
  const expectedSessionId = nonEmptyString(body?.expectedSessionId);
  let response: GatewayResponse;
  try {
    response = await dispatchGatewayMethod("sessions.patch", {
      key: sessionKey,
      ...(agentId ? { agentId } : {}),
      ...(expectedSessionId ? { expectedSessionId } : {}),
      unread: body.unread,
      ...(markerWasProvided ? { expectedMarkedUnreadAt: body.expectedMarkedUnreadAt } : {}),
    });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!response.ok) return gatewayFailure(res, response, "sessions.patch");
  return json(res, 200, { ok: true, sessionKey });
}

export async function handleSessionReadState(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "PATCH") {
    return json(res, 405, { error: "Method Not Allowed" });
  }
  if (applyPublicAttestGate(req, res)) return true;
  if (req.method === "PATCH") return await patchReadState(req, res);

  const result = await listReadStates(res);
  if (result === true) return true;
  return json(res, 200, { ok: true, complete: result.complete, states: result.states });
}
