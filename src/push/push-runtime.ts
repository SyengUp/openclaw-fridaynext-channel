import { pushCandidates as canonicalPushCandidates } from "@syengup/fridaynext-channel-kit/push/push-runtime";
import { logicalSessionKey } from "../adapters/openclaw/session-metadata.js";
import path from "node:path";
import type { DurableRunStore, DurableRuntimeEvent } from "../runtime-v3/durable-run-store.js";
import { getRuntimeV3Store, resolveRuntimeV3Root } from "../runtime-v3/runtime-store.js";

export const PUSH_ORIGIN = "https://gw.syengup.host";
type Kind = "completed" | "failed" | "approval" | "question";
export type PushEvent = {
  kind: Kind;
  serverInstanceId: string;
  sessionKey: string;
  runId: string;
  agentId: string;
  requestId?: string;
  occurredAt: number;
  expiresAt: number;
};
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export { pushIdentity } from "@syengup/fridaynext-channel-kit/push/push-runtime";
export function pushCandidates(
  wire: DurableRuntimeEvent,
): Array<{ event: PushEvent; terminal: boolean }> {
  if (wire.payload.format === "canonical-v1") return canonicalPushCandidates(wire);
  const common = {
    serverInstanceId: wire.serverInstanceId,
    sessionKey: wire.sessionKey,
    runId: wire.runId,
    agentId: wire.agentId,
    occurredAt: wire.occurredAt,
  };
  if (["run.completed", "run.failed"].includes(wire.eventType)) {
    if (wire.sourceKind !== "session" || wire.parentRunId) return [];
    return [
      {
        event: {
          ...common,
          kind: wire.eventType === "run.failed" ? "failed" : "completed",
          expiresAt: wire.occurredAt + 86400000,
        },
        terminal: false,
      },
    ];
  }
  const p = obj(wire.payload);
  const sources = Array.isArray(p._sourceEventBatch)
    ? p._sourceEventBatch.map(obj)
    : [{ type: p._sourceEventType, data: p._sourceEventData }];
  if (!p._sourceEventType && !Array.isArray(p._sourceEventBatch)) {
    for (const type of ["approval", "question"])
      if (wire.eventType.startsWith(type + "."))
        sources.push({ type, data: { ...p, op: wire.eventType.slice(type.length + 1) } });
  }
  const result: Array<{ event: PushEvent; terminal: boolean }> = [];
  for (const source of sources) {
    const data = obj(source.data);
    let kind: Kind;
    let requestId: unknown;
    let terminal = false;
    if (source.type === "approval" || source.type === "question") {
      kind = source.type;
      requestId = data[kind === "approval" ? "approvalId" : "questionId"];
      terminal = ["resolved", "expired", "cancelled"].includes(String(data.op));
      if (!terminal && data.op !== "request") continue;
    } else if (source.type === "deliver") {
      kind = "question";
      requestId = obj(obj(obj(data.payload).channelData).askUser).questionId;
    } else continue;
    if (typeof requestId !== "string" || !requestId) continue;
    const expiry =
      typeof data.expiresAtMs === "number" ? data.expiresAtMs : wire.occurredAt + 3600000;
    result.push({
      event: { ...common, kind, requestId, expiresAt: Math.min(expiry, wire.occurredAt + 3600000) },
      terminal,
    });
  }
  return result;
}

import { PushRuntime as SharedPushRuntime } from "@syengup/fridaynext-channel-kit/push/push-runtime";
export class PushRuntime extends SharedPushRuntime {
  constructor(
    file: string,
    store: DurableRunStore,
    post?: (grant: string, event: PushEvent) => Promise<number>,
    now?: () => number,
    cancelPost?: (grant: string, id: string) => Promise<number>,
  ) {
    super(file, store, post, now, cancelPost, pushCandidates, (event, registration) =>
      registration.eventFormat === "canonical-v1"
        ? { ...event, sessionKey: logicalSessionKey(event.sessionKey) }
        : event,
    );
  }
}
import { processRef } from "../process-state.js";
const active = processRef<{ root: string; store: DurableRunStore; value: PushRuntime } | undefined>(
  Symbol.for("@syengup/friday-channel-next/push-runtime"),
  undefined,
);
export function getPushRuntime(): PushRuntime {
  const root = resolveRuntimeV3Root(),
    store = getRuntimeV3Store();
  if (!active.value || active.value.root !== root || active.value.store !== store)
    active.value = {
      root,
      store,
      value: new PushRuntime(path.join(root, "push-state.json"), store),
    };
  return active.value.value;
}
