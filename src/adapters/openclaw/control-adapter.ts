import type { ControlRequest, ControlResponse, JSONObject } from "@syengup/fridaynext-channel-kit";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { ensureGatewayRequestScopes } from "../../agent/operator-scope.js";
import { readOpenClawApproval } from "../../approval/approval-state.js";
import { submitOpenClawApproval } from "../../http/handlers/approvals.js";
import { submitOpenClawCalendarResult } from "../../http/handlers/calendar-result.js";
import { submitOpenClawHealthResult } from "../../http/handlers/health-query-result.js";
import { submitOpenClawLocationResult } from "../../http/handlers/location-query-result.js";
import { submitOpenClawQuestion } from "../../http/handlers/questions.js";
import { getRuntimeV3Store } from "../../runtime-v3/runtime-store.js";
import { canonicalizeRuntimeEvent } from "./canonical-events.js";
import { logicalSessionKey } from "./session-metadata.js";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string => (typeof value === "string" ? value : "");

export function openClawControls() {
  return {
    lookupControl: lookupOpenClawControl,
    async respondControl(id: string, response: ControlResponse): Promise<JSONObject> {
      const current = await this.lookupControl(id);
      if (!current || current.generation !== response.generation || current.status !== "pending")
        throw new Error("请求状态已变化");
      const answer = object(response.answer);
      if (
        current.kind === "approval" &&
        !current.options?.some((option) => option.id === answer.decision)
      )
        throw new Error("当前请求不支持该审批决定");
      const approvalKind = current.data?.approvalKind;
      const result = await (current.kind === "question"
        ? submitOpenClawQuestion(id, answer)
        : submitOpenClawApproval(
            id,
            answer,
            approvalKind === "exec" || approvalKind === "plugin" || approvalKind === "system-agent"
              ? approvalKind
              : undefined,
          ));
      if (result.status >= 400) throw new Error(`宿主控制操作失败：${result.status}`);
      return JSON.parse(JSON.stringify(result.body)) as JSONObject;
    },
  };
}

export async function respondOpenClawDevice(body: Record<string, unknown>): Promise<JSONObject> {
  const handler = (
    {
      health: submitOpenClawHealthResult,
      calendar: submitOpenClawCalendarResult,
      location: submitOpenClawLocationResult,
    } as Record<string, typeof submitOpenClawHealthResult>
  )[text(body.tool)];
  if (!handler) throw new Error("不支持的设备能力");
  const result = await handler(body);
  if (result.status >= 400) throw new Error(`宿主设备结果操作失败：${result.status}`);
  return JSON.parse(JSON.stringify(result.body)) as JSONObject;
}

export async function lookupOpenClawControl(id: string): Promise<ControlRequest | null> {
  const store = getRuntimeV3Store();
  let saved: Record<string, unknown> | undefined,
    runId = "",
    sessionKey = "",
    kind: "approval" | "question" = id.startsWith("ask_") ? "question" : "approval";
  for (const run of store.runs().reverse()) {
    const updates = store
      .eventsForRun(run.runId)
      .flatMap(
        (event) =>
          (object(canonicalizeRuntimeEvent(event).payload).updates as Array<
            Record<string, unknown>
          >) ?? [],
      );
    const match = updates.reverse().find((update) => update.kind === "control" && update.id === id);
    if (match) {
      saved = object(match.data);
      runId = run.runId;
      sessionKey = run.sessionKey;
      kind = saved.kind === "question" ? "question" : "approval";
      break;
    }
  }
  let record: Record<string, unknown>;
  if (kind === "approval") {
    const approval = await readOpenClawApproval(id);
    if (!approval) return null;
    record = approval;
  } else {
    ensureGatewayRequestScopes(["operator.questions"]);
    const result = await dispatchGatewayMethod("question.get", { id });
    if (!result.ok) {
      const error = object(result.error),
        reason = text(object(error.details).reason);
      if (reason.includes("NOT_FOUND") || text(error.message).toLowerCase().includes("not found"))
        return null;
      throw new Error("无法取得宿主请求状态");
    }
    record = object(object(result.payload).question);
  }
  if (!Object.keys(record).length) return null;
  runId = text(record.runId) || runId;
  sessionKey = text(record.sessionKey) || sessionKey;
  // 宿主全局审批没有 Friday 运行归属时，不构造空身份或新的控制代际。
  if (!runId || !sessionKey) return null;
  const status = text(record.status);
  const terminal =
    status === "pending"
      ? "pending"
      : status === "expired"
        ? "expired"
        : status === "cancelled"
          ? "cancelled"
          : "resolved";
  const keys = [
    "questions",
    "answers",
    "actions",
    "title",
    "description",
    "commandText",
    "commandPreview",
    "cwd",
    "host",
    "severity",
    "metadata",
    "expiresAtMs",
    "decision",
    "status",
  ];
  const data: Record<string, unknown> = {
    ...saved,
    ...Object.fromEntries(
      keys
        .filter((key) => object(record.presentation)[key] !== undefined)
        .map((key) => [key, object(record.presentation)[key]]),
    ),
    ...Object.fromEntries(
      keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]),
    ),
  };
  if (kind === "approval") {
    const presentation = object(record.presentation);
    const savedActions = Array.isArray(data.actions)
      ? (data.actions as Array<Record<string, unknown>>)
      : [];
    const labels: Record<string, string> = {
      "allow-once": "Allow Once",
      "allow-always": "Allow Always",
      deny: "Deny",
    };
    data.approvalKind = presentation.kind;
    data.actions =
      terminal === "pending" && Array.isArray(presentation.allowedDecisions)
        ? presentation.allowedDecisions
            .filter((decision): decision is string => typeof decision === "string")
            .map((decision) => ({
              ...savedActions.find((action) => action.decision === decision),
              decision,
              label:
                text(savedActions.find((action) => action.decision === decision)?.label) ||
                labels[decision] ||
                decision,
            }))
        : [];
  }
  const generation = text(saved?.generation) || `${runId}:${id}`;
  const expiresAt =
    typeof record.expiresAtMs === "number"
      ? record.expiresAtMs
      : typeof saved?.expiresAtMs === "number"
        ? saved.expiresAtMs
        : undefined;
  const actions = Array.isArray(data.actions)
    ? (data.actions as Array<Record<string, unknown>>)
    : [];
  let owner = store.run(runId);
  const visited = new Set<string>();
  while (owner?.parentRunId && !visited.has(owner.runId)) {
    visited.add(owner.runId);
    const parent = store.run(owner.parentRunId);
    if (!parent) break;
    owner = parent;
  }
  return {
    id,
    kind,
    sessionKey: logicalSessionKey(owner?.sessionKey ?? sessionKey),
    runId,
    generation,
    status: terminal,
    expiresAt,
    options: actions.map((action) => ({
      id: text(action.decision),
      label: text(action.label),
      scope: text(action.scope),
    })),
    data: JSON.parse(JSON.stringify(data)) as JSONObject,
  };
}
