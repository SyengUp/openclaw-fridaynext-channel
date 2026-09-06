import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export type DurableRunPhase =
  | "queued"
  | "dispatching"
  | "running"
  | "waitingForApproval"
  | "waitingForDevice"
  | "cancelPending"
  | "reconciling"
  | "completed"
  | "failed"
  | "cancelled";

export type DurableRunCommand = {
  clientRequestId: string;
  deviceId: string;
  sessionKey: string;
  agentId: string;
  text: string;
  attachments: string[];
  sessionOptions?: Record<string, unknown>;
};

export type DurableRunRecord = DurableRunCommand & {
  runId: string;
  payloadHash: string;
  phase: DurableRunPhase;
  createdAt: number;
  updatedAt: number;
  lastRunSeq: number;
  terminalReason?: string;
  rootRunId?: string;
  parentRunId?: string;
};

export type DurableRuntimeEvent = {
  protocolVersion: 3;
  serverInstanceId: string;
  eventId: number;
  sessionKey: string;
  agentId: string;
  runId: string;
  rootRunId?: string;
  parentRunId?: string;
  runSeq: number;
  eventType: string;
  occurredAt: number;
  payload: Record<string, unknown>;
};

export type AcceptCommandResult = {
  outcome: "accepted" | "replayed" | "conflict" | "deleted";
  run?: DurableRunRecord;
  deletedRunId?: string;
};

type DurableDeletedRequest = {
  deviceId: string;
  clientRequestId: string;
  runId: string;
  payloadHash: string;
};

type DurableSessionDeletion = {
  sessionKey: string;
  deletedAt: number;
  runIds: string[];
  requests: DurableDeletedRequest[];
};

export type DurableCommandReceipt = {
  kind: string;
  commandId: string;
  payloadHash: string;
  state: "prepared" | "succeeded";
  response: Record<string, unknown>;
  updatedAt: number;
};

export type CommandReceiptStatus = "missing" | "prepared" | "replayed" | "conflict";

export type DurableDeviceRequest = {
  kind: string;
  requestId: string;
  deviceId: string;
  sessionKey: string;
  runId?: string;
  sourceEventType?: string;
  payload?: unknown;
  payloadHash: string;
  state: "pending" | "completed";
  createdAt: number;
  updatedAt: number;
};

export type RegisterDeviceRequest = {
  kind: string;
  requestId: string;
  deviceId: string;
  sessionKey: string;
  runId?: string;
  sourceEventType: string;
  payload: unknown;
};

type PersistedAcknowledgements = Record<string, number>;
type PersistedEventHeads = Record<string, number>;

type DurableRunSnapshot = {
  protocolVersion: 3;
  runId: string;
  deviceId: string;
  sessionKey: string;
  lastRunSeq: number;
  updatedAt: number;
  events: DurableRuntimeEvent[];
};

const terminalPhases = new Set<DurableRunPhase>(["completed", "failed", "cancelled"]);
const busyPhases = new Set<DurableRunPhase>([
  "dispatching",
  "running",
  "waitingForApproval",
  "waitingForDevice",
  "cancelPending",
  "reconciling",
]);

/**
 * Meta events that describe a run's outcome rather than drive its lifecycle. The AI
 * session title is generated asynchronously and can land after the run that produced
 * the first message already completed (fast reply + slow utility model); it must still
 * reach runtime-v3 clients live and on replay — the legacy SSE broadcast is invisible
 * to them. `phaseAfterEvent` leaves the terminal phase untouched, and `appendRunEvent`
 * rewrites the run snapshot afterwards so the event survives journal compaction.
 */
const postTerminalMetaEvents = new Set(["session-title"]);

function normalizedDeviceId(deviceId: string): string {
  return deviceId.trim().toUpperCase();
}

function normalizedCommand(command: DurableRunCommand): DurableRunCommand {
  const sessionOptions = command.sessionOptions
    ? Object.fromEntries(
        Object.entries(command.sessionOptions).filter(([, value]) => value !== undefined),
      )
    : undefined;
  return {
    clientRequestId: command.clientRequestId.trim(),
    deviceId: normalizedDeviceId(command.deviceId),
    sessionKey: command.sessionKey.trim(),
    agentId: command.agentId.trim() || "main",
    text: command.text,
    attachments: [...command.attachments],
    ...(sessionOptions && Object.keys(sessionOptions).length > 0 ? { sessionOptions } : {}),
  };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) out[key] = canonicalValue(record[key]);
  return out;
}

function payloadHash(command: DurableRunCommand): string {
  return canonicalPayloadHash(command);
}

function canonicalPayloadHash(payload: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalValue(payload)))
    .digest("hex");
}

function safeDiskKey(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isRunRecord(value: unknown): value is DurableRunRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<DurableRunRecord>;
  return (
    typeof record.runId === "string" &&
    typeof record.clientRequestId === "string" &&
    typeof record.deviceId === "string" &&
    typeof record.sessionKey === "string" &&
    typeof record.phase === "string" &&
    typeof record.updatedAt === "number"
  );
}

function isRuntimeEvent(value: unknown): value is DurableRuntimeEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<DurableRuntimeEvent>;
  return (
    event.protocolVersion === 3 &&
    typeof event.eventId === "number" &&
    typeof event.runSeq === "number" &&
    typeof event.runId === "string" &&
    typeof event.sessionKey === "string" &&
    typeof event.eventType === "string"
  );
}

function isCommandReceipt(value: unknown): value is DurableCommandReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<DurableCommandReceipt>;
  return (
    typeof receipt.kind === "string" &&
    typeof receipt.commandId === "string" &&
    typeof receipt.payloadHash === "string" &&
    (receipt.state === "prepared" || receipt.state === "succeeded") &&
    typeof receipt.updatedAt === "number" &&
    !!receipt.response &&
    typeof receipt.response === "object" &&
    !Array.isArray(receipt.response)
  );
}

function isDeviceRequest(value: unknown): value is DurableDeviceRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<DurableDeviceRequest>;
  return (
    typeof request.kind === "string" &&
    typeof request.requestId === "string" &&
    typeof request.deviceId === "string" &&
    typeof request.sessionKey === "string" &&
    typeof request.payloadHash === "string" &&
    (request.state === "pending" || request.state === "completed") &&
    typeof request.createdAt === "number" &&
    typeof request.updatedAt === "number"
  );
}

function isSessionDeletion(value: unknown): value is DurableSessionDeletion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const deletion = value as Partial<DurableSessionDeletion>;
  return (
    typeof deletion.sessionKey === "string" &&
    typeof deletion.deletedAt === "number" &&
    Array.isArray(deletion.runIds) &&
    deletion.runIds.every((runId) => typeof runId === "string") &&
    Array.isArray(deletion.requests) &&
    deletion.requests.every(
      (request) =>
        !!request &&
        typeof request === "object" &&
        typeof request.deviceId === "string" &&
        typeof request.clientRequestId === "string" &&
        typeof request.runId === "string" &&
        typeof request.payloadHash === "string",
    )
  );
}

function canonicalSessionKey(sessionKey: string): string {
  return sessionKey.trim().toLowerCase();
}

function terminalPhaseForEvent(eventType: string): DurableRunPhase | undefined {
  if (eventType === "run.completed") return "completed";
  if (eventType === "run.failed") return "failed";
  if (eventType === "run.cancelled") return "cancelled";
  return undefined;
}

function phaseAfterEvent(current: DurableRunPhase, eventType: string): DurableRunPhase {
  if (eventType === "run.started") return "running";
  const terminalPhase = terminalPhaseForEvent(eventType);
  if (terminalPhase) return terminalPhase;
  if (eventType === "approval.request") return "waitingForApproval";
  if (eventType === "approval.resolved" || eventType === "approval.expired") return "running";
  if (eventType.startsWith("device.") && eventType.endsWith(".request")) {
    return "waitingForDevice";
  }
  if (eventType.startsWith("device.") && eventType.endsWith(".result")) return "running";
  return current;
}

/**
 * Durable protocol-v3 run ledger.
 *
 * Every mutation appends a complete record before it is exposed to callers. JSONL is intentional:
 * the plugin must run on old OpenClaw hosts without a native SQLite dependency. A corrupt or torn
 * final line is ignored during reconstruction; all earlier committed records remain readable.
 */
export class DurableRunStore {
  private readonly runsById = new Map<string, DurableRunRecord>();
  private readonly runIdByRequest = new Map<string, string>();
  private readonly runIdsBySessionKey = new Map<string, Set<string>>();
  private readonly eventHeadByDevice = new Map<string, number>();
  private readonly archivedRunSeqByRunId = new Map<string, number>();
  private acknowledgements: PersistedAcknowledgements = {};
  private readonly commandReceiptsByKey = new Map<string, DurableCommandReceipt>();
  private readonly deviceRequestsByKey = new Map<string, DurableDeviceRequest>();
  private readonly sessionDeletionByKey = new Map<string, DurableSessionDeletion>();
  private readonly deletedRequestsByKey = new Map<string, DurableDeletedRequest>();
  private readonly deletedRunIds = new Set<string>();
  private readonly listenersByDevice = new Map<string, Set<(event: DurableRuntimeEvent) => void>>();
  readonly serverInstanceId: string;

  constructor(private readonly rootDir: string) {
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.mkdirSync(this.deliveryDir(), { recursive: true });
    fs.mkdirSync(this.runSnapshotsDir(), { recursive: true });
    this.serverInstanceId = this.loadOrCreateServerInstanceId();
    this.loadSessionDeletions();
    this.loadEventHeads();
    this.loadRuns();
    this.repairEventHeadsFromDeliveryJournals();
    this.repairRunsFromDeliveryJournals();
    this.acknowledgements = this.loadAcknowledgements();
    this.ensureTerminalRunSnapshots();
    for (const deviceId of Object.keys(this.acknowledgements)) {
      this.compactAcknowledgedDeliveryEvents(deviceId);
    }
    this.loadCommandReceipts();
    this.loadDeviceRequests();
    this.compactDeletedSessionState();
  }

  acceptCommand(rawCommand: DurableRunCommand): AcceptCommandResult {
    const command = normalizedCommand(rawCommand);
    if (!command.clientRequestId || !command.deviceId || !command.sessionKey) {
      throw new Error("clientRequestId, deviceId and sessionKey are required");
    }
    const requestKey = this.requestKey(command.deviceId, command.clientRequestId);
    const hash = payloadHash(command);
    const deleted = this.deletedRequestsByKey.get(requestKey);
    if (deleted) {
      return deleted.payloadHash === hash
        ? { outcome: "deleted", deletedRunId: deleted.runId }
        : { outcome: "conflict", deletedRunId: deleted.runId };
    }
    const existingId = this.runIdByRequest.get(requestKey);
    if (existingId) {
      const existing = this.runsById.get(existingId);
      if (!existing) throw new Error(`run ledger index is corrupt for ${existingId}`);
      return { outcome: existing.payloadHash === hash ? "replayed" : "conflict", run: existing };
    }

    const deletedAt = this.sessionDeletionByKey.get(
      canonicalSessionKey(command.sessionKey),
    )?.deletedAt;
    const now = Math.max(Date.now(), (deletedAt ?? -1) + 1);
    const record: DurableRunRecord = {
      ...command,
      runId: crypto.randomUUID(),
      payloadHash: hash,
      phase: "queued",
      createdAt: now,
      updatedAt: now,
      lastRunSeq: 0,
    };
    this.persistRun(record);
    this.runsById.set(record.runId, record);
    this.runIdByRequest.set(requestKey, record.runId);
    this.indexRunSession(record);
    return { outcome: "accepted", run: record };
  }

  run(runId: string): DurableRunRecord | undefined {
    return this.runsById.get(runId.trim());
  }

  /**
   * Durably forgets every process artifact owned by a conversation. The deletion marker is
   * fsynced before any index or journal is rewritten: after a crash, reconstruction filters the
   * old records and finishes compaction. Request hashes (never prompts or attachment names) remain
   * only to prevent an uncertain stale POST from recreating a conversation the user deleted.
   */
  deleteSession(rawSessionKey: string): void {
    const sessionKey = rawSessionKey.trim();
    const canonicalKey = canonicalSessionKey(sessionKey);
    if (!canonicalKey) throw new Error("sessionKey is required");
    const runs = [...this.runsById.values()].filter(
      (run) => canonicalSessionKey(run.sessionKey) === canonicalKey,
    );
    const previous = this.sessionDeletionByKey.get(canonicalKey);
    const deletion: DurableSessionDeletion = {
      sessionKey,
      deletedAt: Math.max(Date.now(), (previous?.deletedAt ?? -1) + 1),
      runIds: runs.map((run) => run.runId),
      requests: runs.map((run) => ({
        deviceId: run.deviceId,
        clientRequestId: run.clientRequestId,
        runId: run.runId,
        payloadHash: run.payloadHash,
      })),
    };
    this.appendLineDurable(this.sessionDeletionsFile(), deletion);
    this.indexSessionDeletion(deletion);

    for (const run of runs) {
      this.runsById.delete(run.runId);
      this.runIdByRequest.delete(this.requestKey(run.deviceId, run.clientRequestId));
      this.archivedRunSeqByRunId.delete(run.runId);
    }
    this.rebuildSessionRunIndex();
    for (const [key, request] of this.deviceRequestsByKey) {
      if (canonicalSessionKey(request.sessionKey) === canonicalKey) {
        this.deviceRequestsByKey.delete(key);
      }
    }
    this.compactDeletedSessionState();
  }

  runs(deviceId?: string): DurableRunRecord[] {
    const normalized = deviceId ? normalizedDeviceId(deviceId) : null;
    return [...this.runsById.values()]
      .filter((run) => normalized === null || run.deviceId === normalized)
      .sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
  }

  unfinishedRuns(deviceId?: string): DurableRunRecord[] {
    return this.runs(deviceId).filter((run) => !terminalPhases.has(run.phase));
  }

  activeRunForSession(sessionKey: string, deviceId?: string): DurableRunRecord | undefined {
    const normalized = deviceId ? normalizedDeviceId(deviceId) : null;
    return this.runsForSession(sessionKey)
      .filter((run) => normalized === null || run.deviceId === normalized)
      .filter((run) => busyPhases.has(run.phase))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0];
  }

  claimRunnable(): DurableRunRecord[] {
    const busySessions = new Set(
      [...this.runsById.values()]
        .filter((run) => busyPhases.has(run.phase))
        .map((run) => run.sessionKey),
    );
    const claimed: DurableRunRecord[] = [];
    for (const run of this.runs().filter((candidate) => candidate.phase === "queued")) {
      if (busySessions.has(run.sessionKey)) continue;
      const next = this.transition(run.runId, "dispatching");
      if (!next) continue;
      busySessions.add(run.sessionKey);
      claimed.push(next);
    }
    return claimed;
  }

  /** Claim exactly one queued command when it is the head of an otherwise-idle session. */
  claimRun(runId: string): DurableRunRecord | undefined {
    const current = this.runsById.get(runId.trim());
    if (!current) return undefined;
    if (current.phase !== "queued") return undefined;
    const sessionRuns = this.runsForSession(current.sessionKey);
    if (sessionRuns.some((run) => run.runId !== current.runId && busyPhases.has(run.phase))) {
      return undefined;
    }
    const firstQueued = sessionRuns.find((run) => run.phase === "queued");
    if (firstQueued?.runId !== current.runId) return undefined;
    return this.transition(current.runId, "dispatching");
  }

  transition(
    runId: string,
    phase: DurableRunPhase,
    terminalReason?: string,
  ): DurableRunRecord | undefined {
    const current = this.runsById.get(runId.trim());
    if (!current) return undefined;
    if (terminalPhases.has(current.phase) && current.phase !== phase) return current;
    const next: DurableRunRecord = {
      ...current,
      phase,
      updatedAt: Date.now(),
      ...(terminalReason ? { terminalReason } : {}),
    };
    this.persistRun(next);
    this.runsById.set(next.runId, next);
    return next;
  }

  appendRunEvent(
    runId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): DurableRuntimeEvent {
    const current = this.runsById.get(runId.trim());
    if (!current) throw new Error(`unknown runId: ${runId}`);
    const requestedTerminalPhase = terminalPhaseForEvent(eventType);
    if (terminalPhases.has(current.phase) && !postTerminalMetaEvents.has(eventType)) {
      const existingEvents = this.eventsForRun(current.runId);
      const existingTerminal = existingEvents
        .filter((event) => terminalPhaseForEvent(event.eventType) !== undefined)
        .at(-1);
      if (existingTerminal) return existingTerminal;
      const existingLast = existingEvents.at(-1);
      if (existingLast) return existingLast;
      if (!requestedTerminalPhase) {
        throw new Error(
          `cannot append ${eventType} to terminal run without a terminal event: ${runId}`,
        );
      }
    }
    const deviceId = current.deviceId;
    const runSeq = current.lastRunSeq + 1;
    const eventId = this.nextEventId(deviceId);
    const event: DurableRuntimeEvent = {
      protocolVersion: 3,
      serverInstanceId: this.serverInstanceId,
      eventId,
      sessionKey: current.sessionKey,
      agentId: current.agentId,
      runId: current.runId,
      ...(current.rootRunId ? { rootRunId: current.rootRunId } : {}),
      ...(current.parentRunId ? { parentRunId: current.parentRunId } : {}),
      runSeq,
      eventType: eventType.trim(),
      occurredAt: Date.now(),
      payload,
    };
    this.appendLineDurable(this.deliveryFile(deviceId), event);
    this.eventHeadByDevice.set(deviceId, eventId);

    const updated: DurableRunRecord = {
      ...current,
      phase: phaseAfterEvent(current.phase, eventType),
      lastRunSeq: runSeq,
      updatedAt: event.occurredAt,
    };
    // 已 fsync 的投递记录足以在崩溃后恢复非终态 run 与事件游标。终态必须额外落盘，
    // 因为快照压缩会删除最终投递记录；更早的阶段仍可由投递日志恢复。
    if (terminalPhases.has(updated.phase)) this.persistRun(updated);
    this.runsById.set(updated.runId, updated);
    if (terminalPhases.has(updated.phase)) this.persistRunSnapshot(updated);
    for (const listener of this.listenersByDevice.get(deviceId) ?? []) listener(event);
    return event;
  }

  subscribe(deviceId: string, listener: (event: DurableRuntimeEvent) => void): () => void {
    const normalized = normalizedDeviceId(deviceId);
    const listeners = this.listenersByDevice.get(normalized) ?? new Set();
    listeners.add(listener);
    this.listenersByDevice.set(normalized, listeners);
    return () => {
      const current = this.listenersByDevice.get(normalized);
      current?.delete(listener);
      if (current?.size === 0) this.listenersByDevice.delete(normalized);
    };
  }

  /** Live protocol-v3 stream listeners for the device (`GET /friday-next/v3/events`). Device
   * tools use this as their online gate alongside the legacy v1 emitter registry: the 1.5 app
   * connects only to v3, so a v1-only check would report a connected iPhone as offline. */
  deviceListenerCount(deviceId: string): number {
    return this.listenersByDevice.get(normalizedDeviceId(deviceId))?.size ?? 0;
  }

  eventsAfter(deviceId: string, afterEventId: number, limit = 1_000): DurableRuntimeEvent[] {
    return this.readDeliveryEvents(normalizedDeviceId(deviceId))
      .filter((event) => event.eventId > afterEventId)
      .slice(0, Math.max(0, Math.floor(limit)));
  }

  eventHead(deviceId: string): number {
    const normalized = normalizedDeviceId(deviceId);
    const cached = this.eventHeadByDevice.get(normalized);
    if (cached !== undefined) return cached;
    const events = this.eventsAfter(normalized, 0, Number.MAX_SAFE_INTEGER);
    const head = events.at(-1)?.eventId ?? 0;
    this.eventHeadByDevice.set(normalized, head);
    return head;
  }

  /** First event still replayable from the delivery journal (head + 1 when fully compacted). */
  eventFloor(deviceId: string): number {
    const normalized = normalizedDeviceId(deviceId);
    const first = this.readDeliveryEvents(normalized).at(0)?.eventId;
    if (first !== undefined) return first;
    const head = this.eventHead(normalized);
    return head > 0 ? head + 1 : 0;
  }

  /** Complete process history, including terminal runs compacted out of the delivery journal. */
  eventsForSession(sessionKey: string): DurableRuntimeEvent[] {
    const runs = this.runsForSession(sessionKey);
    const runIds = new Set(runs.map((run) => run.runId));
    const deliveryByRun = new Map<string, DurableRuntimeEvent[]>();
    for (const deviceId of new Set(runs.map((run) => run.deviceId))) {
      for (const event of this.readDeliveryEvents(deviceId)) {
        if (!runIds.has(event.runId)) continue;
        const values = deliveryByRun.get(event.runId) ?? [];
        values.push(event);
        deliveryByRun.set(event.runId, values);
      }
    }
    const events = runs.flatMap((run) => {
      const archived = this.readRunSnapshot(run.runId)?.events ?? [];
      const delivery = deliveryByRun.get(run.runId) ?? [];
      return [
        ...new Map([...archived, ...delivery].map((event) => [event.runSeq, event])).values(),
      ];
    });
    return [
      ...new Map(events.map((event) => [`${event.runId}:${event.runSeq}`, event])).values(),
    ].sort((a, b) => a.occurredAt - b.occurredAt || a.runSeq - b.runSeq);
  }

  eventsForRun(runId: string): DurableRuntimeEvent[] {
    const run = this.runsById.get(runId.trim());
    if (!run) return [];
    const archived = this.readRunSnapshot(run.runId)?.events ?? [];
    const delivery = this.readDeliveryEvents(run.deviceId).filter(
      (event) => event.runId === run.runId,
    );
    return [
      ...new Map([...archived, ...delivery].map((event) => [event.runSeq, event])).values(),
    ].sort((a, b) => a.runSeq - b.runSeq || a.eventId - b.eventId);
  }

  acknowledge(deviceId: string, throughEventId: number): number {
    const normalized = normalizedDeviceId(deviceId);
    const bounded = Math.max(0, Math.min(Math.floor(throughEventId), this.eventHead(normalized)));
    const current = this.acknowledgements[normalized] ?? 0;
    if (bounded <= current) return current;
    this.acknowledgements = { ...this.acknowledgements, [normalized]: bounded };
    this.writeJSONAtomically(this.acknowledgementsFile(), this.acknowledgements);
    this.compactAcknowledgedDeliveryEvents(normalized);
    return bounded;
  }

  acknowledgedEventId(deviceId: string): number {
    return this.acknowledgements[normalizedDeviceId(deviceId)] ?? 0;
  }

  commandReceiptStatus(kind: string, commandId: string, payload: unknown): CommandReceiptStatus {
    const receipt = this.commandReceiptsByKey.get(this.commandReceiptKey(kind, commandId));
    if (!receipt) return "missing";
    if (receipt.payloadHash !== canonicalPayloadHash(payload)) return "conflict";
    return receipt.state === "succeeded" ? "replayed" : "prepared";
  }

  prepareCommandReceipt(kind: string, commandId: string, payload: unknown): DurableCommandReceipt {
    const key = this.commandReceiptKey(kind, commandId);
    const existing = this.commandReceiptsByKey.get(key);
    const hash = canonicalPayloadHash(payload);
    if (existing) {
      if (existing.payloadHash !== hash) {
        throw new Error(`conflicting durable command payload for ${kind}:${commandId}`);
      }
      return existing;
    }
    const receipt: DurableCommandReceipt = {
      kind: kind.trim(),
      commandId: commandId.trim(),
      payloadHash: hash,
      state: "prepared",
      response: {},
      updatedAt: Date.now(),
    };
    this.persistCommandReceipt(receipt);
    this.commandReceiptsByKey.set(key, receipt);
    return receipt;
  }

  completeCommandReceipt(
    kind: string,
    commandId: string,
    payload: unknown,
    response: Record<string, unknown>,
  ): DurableCommandReceipt {
    const prepared = this.prepareCommandReceipt(kind, commandId, payload);
    const receipt: DurableCommandReceipt = {
      ...prepared,
      state: "succeeded",
      response: { ...response },
      updatedAt: Date.now(),
    };
    this.persistCommandReceipt(receipt);
    this.commandReceiptsByKey.set(this.commandReceiptKey(kind, commandId), receipt);
    return receipt;
  }

  commandReceipt(kind: string, commandId: string): DurableCommandReceipt | undefined {
    return this.commandReceiptsByKey.get(this.commandReceiptKey(kind, commandId));
  }

  registerDeviceRequest(input: RegisterDeviceRequest): DurableDeviceRequest {
    const kind = input.kind.trim();
    const requestId = input.requestId.trim();
    const deviceId = normalizedDeviceId(input.deviceId);
    const sessionKey = input.sessionKey.trim();
    const sourceEventType = input.sourceEventType.trim();
    if (!kind || !requestId || !deviceId || !sessionKey || !sourceEventType) {
      throw new Error("kind, requestId, deviceId, sessionKey and sourceEventType are required");
    }
    const key = this.deviceRequestKey(kind, requestId);
    const existing = this.deviceRequestsByKey.get(key);
    const hash = canonicalPayloadHash(input.payload);
    if (existing) {
      if (
        existing.deviceId !== deviceId ||
        existing.sessionKey !== sessionKey ||
        existing.runId !== input.runId ||
        (existing.sourceEventType !== undefined && existing.sourceEventType !== sourceEventType) ||
        existing.payloadHash !== hash
      ) {
        throw new Error(`conflicting durable device request for ${kind}:${requestId}`);
      }
      return existing;
    }
    const now = Date.now();
    const request: DurableDeviceRequest = {
      kind,
      requestId,
      deviceId,
      sessionKey,
      ...(input.runId?.trim() ? { runId: input.runId.trim() } : {}),
      sourceEventType,
      payload: canonicalValue(input.payload),
      payloadHash: hash,
      state: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.persistDeviceRequest(request);
    this.deviceRequestsByKey.set(key, request);
    return request;
  }

  completeDeviceRequest(kind: string, requestId: string): DurableDeviceRequest | undefined {
    const key = this.deviceRequestKey(kind, requestId);
    const existing = this.deviceRequestsByKey.get(key);
    if (!existing || existing.state === "completed") return existing;
    const completed: DurableDeviceRequest = {
      ...existing,
      state: "completed",
      updatedAt: Date.now(),
    };
    this.persistDeviceRequest(completed);
    this.deviceRequestsByKey.set(key, completed);
    return completed;
  }

  completeDeviceRequestWithRunEvent(
    kind: string,
    requestId: string,
    payload: Record<string, unknown>,
  ): DurableDeviceRequest | undefined {
    const request = this.deviceRequest(kind, requestId);
    if (!request) return undefined;

    // The durable run phase is also the replay guard for this boundary. If the
    // process dies after the event journal append but before the device ledger
    // update, replay sees `running` and cannot append a second visible result.
    if (request.runId && this.runsById.get(request.runId)?.phase === "waitingForDevice") {
      this.appendRunEvent(request.runId, `device.${kind}.result`, {
        requestId: request.requestId,
        ...payload,
      });
    }
    return request.state === "pending" ? this.completeDeviceRequest(kind, requestId) : request;
  }

  deviceRequest(kind: string, requestId: string): DurableDeviceRequest | undefined {
    return this.deviceRequestsByKey.get(this.deviceRequestKey(kind, requestId));
  }

  pendingDeviceRequests(deviceId?: string): DurableDeviceRequest[] {
    const normalized = deviceId ? normalizedDeviceId(deviceId) : null;
    return [...this.deviceRequestsByKey.values()]
      .filter((request) => request.state === "pending")
      .filter((request) => normalized === null || request.deviceId === normalized)
      .sort((a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId));
  }

  private requestKey(deviceId: string, clientRequestId: string): string {
    return `${normalizedDeviceId(deviceId)}\u0000${clientRequestId.trim()}`;
  }

  private runsForSession(sessionKey: string): DurableRunRecord[] {
    const ids = this.runIdsBySessionKey.get(sessionKey.trim());
    if (!ids) return [];
    return [...ids]
      .flatMap((runId) => {
        const run = this.runsById.get(runId);
        return run ? [run] : [];
      })
      .sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
  }

  private indexRunSession(run: DurableRunRecord): void {
    const ids = this.runIdsBySessionKey.get(run.sessionKey) ?? new Set<string>();
    ids.add(run.runId);
    this.runIdsBySessionKey.set(run.sessionKey, ids);
  }

  private rebuildSessionRunIndex(): void {
    this.runIdsBySessionKey.clear();
    for (const run of this.runsById.values()) this.indexRunSession(run);
  }

  private commandReceiptKey(kind: string, commandId: string): string {
    return `${kind.trim()}\u0000${commandId.trim()}`;
  }

  private deviceRequestKey(kind: string, requestId: string): string {
    return `${kind.trim()}\u0000${requestId.trim()}`;
  }

  private runsFile(): string {
    return path.join(this.rootDir, "runs.jsonl");
  }

  private deliveryDir(): string {
    return path.join(this.rootDir, "delivery");
  }

  private deliveryFile(deviceId: string): string {
    return path.join(this.deliveryDir(), `${safeDiskKey(normalizedDeviceId(deviceId))}.jsonl`);
  }

  private eventHeadsFile(): string {
    return path.join(this.rootDir, "event-heads.json");
  }

  private runSnapshotsDir(): string {
    return path.join(this.rootDir, "run-snapshots");
  }

  private runSnapshotFile(runId: string): string {
    return path.join(this.runSnapshotsDir(), `${safeDiskKey(runId.trim())}.json.gz`);
  }

  private acknowledgementsFile(): string {
    return path.join(this.rootDir, "acknowledgements.json");
  }

  private commandReceiptsFile(): string {
    return path.join(this.rootDir, "command-receipts.jsonl");
  }

  private deviceRequestsFile(): string {
    return path.join(this.rootDir, "device-requests.jsonl");
  }

  private sessionDeletionsFile(): string {
    return path.join(this.rootDir, "session-deletions.jsonl");
  }

  private serverFile(): string {
    return path.join(this.rootDir, "server.json");
  }

  private loadRuns(): void {
    const file = this.runsFile();
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isRunRecord(parsed)) continue;
        if (this.runWasDeleted(parsed)) continue;
        const previous = this.runsById.get(parsed.runId);
        if (!previous || parsed.updatedAt >= previous.updatedAt)
          this.runsById.set(parsed.runId, parsed);
      } catch {
        // Ignore a corrupt/torn record and continue rebuilding from prior committed lines.
      }
    }
    for (const run of this.runsById.values()) {
      this.runIdByRequest.set(this.requestKey(run.deviceId, run.clientRequestId), run.runId);
      this.indexRunSession(run);
    }
  }

  /**
   * 投递事件是 run 状态与事件游标的崩溃恢复依据。客户端只能看到已经 fsync 的事件；
   * 重启后先从日志补齐投影，再判断 run 是否仍在执行。
   */
  private repairRunsFromDeliveryJournals(): void {
    const repairedRunIds = new Set<string>();
    for (const run of this.runsById.values()) {
      // 终态记录在快照生成前已经独立 fsync，之后也禁止继续追加事件；无需为每次启动
      // 解压它的完整进程快照。这里只修复仍可能处在「事件已落盘、投影未落盘」窗口的 run。
      if (terminalPhases.has(run.phase)) continue;
      for (const event of this.eventsForRun(run.runId)) {
        const current = this.runsById.get(event.runId);
        if (!current || event.runSeq <= current.lastRunSeq) continue;
        const repaired: DurableRunRecord = {
          ...current,
          phase: phaseAfterEvent(current.phase, event.eventType),
          lastRunSeq: event.runSeq,
          updatedAt: Math.max(current.updatedAt, event.occurredAt),
          ...(current.rootRunId || !event.rootRunId ? {} : { rootRunId: event.rootRunId }),
          ...(current.parentRunId || !event.parentRunId ? {} : { parentRunId: event.parentRunId }),
        };
        this.runsById.set(repaired.runId, repaired);
        repairedRunIds.add(repaired.runId);
      }
    }
    for (const runId of repairedRunIds) {
      const repaired = this.runsById.get(runId);
      if (repaired) this.persistRun(repaired);
    }
  }

  private loadEventHeads(): void {
    const file = this.eventHeadsFile();
    if (!fs.existsSync(file)) return;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      for (const [deviceId, value] of Object.entries(parsed)) {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
          this.eventHeadByDevice.set(normalizedDeviceId(deviceId), Math.floor(value));
        }
      }
    } catch {
      // Delivery journals are sufficient to rebuild old installations.
    }
  }

  private repairEventHeadsFromDeliveryJournals(): void {
    let changed = false;
    const deviceIds = new Set([...this.runsById.values()].map((run) => run.deviceId));
    for (const deviceId of deviceIds) {
      const journalHead = this.readDeliveryEvents(deviceId).at(-1)?.eventId ?? 0;
      const persistedHead = this.eventHeadByDevice.get(deviceId) ?? 0;
      if (journalHead > persistedHead) {
        this.eventHeadByDevice.set(deviceId, journalHead);
        changed = true;
      }
    }
    if (changed) this.persistEventHeads();
  }

  private ensureTerminalRunSnapshots(): void {
    for (const run of this.runsById.values()) {
      if (!terminalPhases.has(run.phase)) continue;
      const snapshotFile = this.runSnapshotFile(run.runId);
      // `writeBufferAtomically` 先 fsync 临时文件再 rename；只要目标存在，它就与先前已
      // fsync 的终态 run 对应。启动时信任这对提交顺序，避免把所有历史 gzip 膨胀进堆。
      if (!fs.existsSync(snapshotFile) || fs.statSync(snapshotFile).size === 0) {
        this.persistRunSnapshot(run);
      } else {
        this.archivedRunSeqByRunId.set(run.runId, run.lastRunSeq);
      }
    }
  }

  private persistRunSnapshot(run: DurableRunRecord): void {
    const events = this.eventsForRun(run.runId);
    if (events.length === 0 || events.at(-1)!.runSeq < run.lastRunSeq) return;
    const snapshot: DurableRunSnapshot = {
      protocolVersion: 3,
      runId: run.runId,
      deviceId: run.deviceId,
      sessionKey: run.sessionKey,
      lastRunSeq: run.lastRunSeq,
      updatedAt: run.updatedAt,
      events,
    };
    this.writeBufferAtomically(
      this.runSnapshotFile(run.runId),
      zlib.gzipSync(Buffer.from(JSON.stringify(snapshot), "utf8")),
    );
    this.archivedRunSeqByRunId.set(run.runId, snapshot.lastRunSeq);
  }

  private readRunSnapshot(runId: string): DurableRunSnapshot | undefined {
    const file = this.runSnapshotFile(runId);
    if (!fs.existsSync(file)) return undefined;
    try {
      const parsed: unknown = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      const snapshot = parsed as Partial<DurableRunSnapshot>;
      if (
        snapshot.protocolVersion !== 3 ||
        snapshot.runId !== runId.trim() ||
        typeof snapshot.deviceId !== "string" ||
        typeof snapshot.sessionKey !== "string" ||
        typeof snapshot.lastRunSeq !== "number" ||
        !Array.isArray(snapshot.events) ||
        !snapshot.events.every(isRuntimeEvent)
      ) {
        return undefined;
      }
      return snapshot as DurableRunSnapshot;
    } catch {
      return undefined;
    }
  }

  private compactAcknowledgedDeliveryEvents(deviceId: string): void {
    const normalized = normalizedDeviceId(deviceId);
    const acknowledged = this.acknowledgements[normalized] ?? 0;
    if (acknowledged <= 0) return;
    const events = this.readDeliveryEvents(normalized);
    if (events.length === 0) return;

    const remaining = events.filter((event) => {
      if (event.eventId > acknowledged) return true;
      return (this.archivedRunSeqByRunId.get(event.runId) ?? 0) < event.runSeq;
    });
    if (remaining.length === events.length) return;

    // Persist the monotonic head before removing its final journal record. A crash
    // after this write can at worst leave extra replayable bytes, never reuse an ID.
    this.persistEventHeads();
    this.writeJSONLinesAtomically(this.deliveryFile(normalized), remaining);
  }

  private readDeliveryEvents(deviceId: string): DurableRuntimeEvent[] {
    const file = this.deliveryFile(normalizedDeviceId(deviceId));
    if (!fs.existsSync(file)) return [];
    const events: DurableRuntimeEvent[] = [];
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRuntimeEvent(parsed) && !this.eventWasDeleted(parsed)) events.push(parsed);
      } catch {
        // A torn final append is recoverable; earlier records remain authoritative.
      }
    }
    return events.sort((a, b) => a.eventId - b.eventId);
  }

  private loadCommandReceipts(): void {
    const file = this.commandReceiptsFile();
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isCommandReceipt(parsed)) continue;
        const key = this.commandReceiptKey(parsed.kind, parsed.commandId);
        const previous = this.commandReceiptsByKey.get(key);
        if (!previous || parsed.updatedAt >= previous.updatedAt) {
          this.commandReceiptsByKey.set(key, parsed);
        }
      } catch {
        // Ignore a corrupt/torn tail and retain all previously committed receipts.
      }
    }
  }

  private loadDeviceRequests(): void {
    const file = this.deviceRequestsFile();
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isDeviceRequest(parsed)) continue;
        if (this.deviceRequestWasDeleted(parsed)) continue;
        const key = this.deviceRequestKey(parsed.kind, parsed.requestId);
        const previous = this.deviceRequestsByKey.get(key);
        if (!previous || parsed.updatedAt >= previous.updatedAt) {
          this.deviceRequestsByKey.set(key, parsed);
        }
      } catch {
        // Ignore a corrupt/torn tail and retain all previously committed device requests.
      }
    }
  }

  private persistRun(run: DurableRunRecord): void {
    this.appendLineDurable(this.runsFile(), run);
  }

  private persistCommandReceipt(receipt: DurableCommandReceipt): void {
    this.appendLineDurable(this.commandReceiptsFile(), receipt);
  }

  private persistDeviceRequest(request: DurableDeviceRequest): void {
    this.appendLineDurable(this.deviceRequestsFile(), request);
  }

  private loadSessionDeletions(): void {
    const file = this.sessionDeletionsFile();
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isSessionDeletion(parsed)) continue;
        this.indexSessionDeletion(parsed);
      } catch {
        // A torn final marker is ignored; all earlier fsynced deletions remain authoritative.
      }
    }
  }

  private indexSessionDeletion(deletion: DurableSessionDeletion): void {
    const key = canonicalSessionKey(deletion.sessionKey);
    const previous = this.sessionDeletionByKey.get(key);
    if (!previous || deletion.deletedAt >= previous.deletedAt) {
      this.sessionDeletionByKey.set(key, deletion);
    }
    for (const runId of deletion.runIds) this.deletedRunIds.add(runId);
    for (const request of deletion.requests) {
      this.deletedRequestsByKey.set(
        this.requestKey(request.deviceId, request.clientRequestId),
        request,
      );
    }
  }

  private runWasDeleted(run: DurableRunRecord): boolean {
    if (this.deletedRunIds.has(run.runId)) return true;
    const deletion = this.sessionDeletionByKey.get(canonicalSessionKey(run.sessionKey));
    return deletion !== undefined && run.createdAt <= deletion.deletedAt;
  }

  private eventWasDeleted(event: DurableRuntimeEvent): boolean {
    if (this.deletedRunIds.has(event.runId)) return true;
    const deletion = this.sessionDeletionByKey.get(canonicalSessionKey(event.sessionKey));
    return deletion !== undefined && event.occurredAt <= deletion.deletedAt;
  }

  private deviceRequestWasDeleted(request: DurableDeviceRequest): boolean {
    const deletion = this.sessionDeletionByKey.get(canonicalSessionKey(request.sessionKey));
    return deletion !== undefined && request.createdAt <= deletion.deletedAt;
  }

  private compactDeletedSessionState(): void {
    if (this.sessionDeletionByKey.size === 0) return;
    this.writeJSONLinesAtomically(this.runsFile(), [...this.runsById.values()]);
    this.writeJSONLinesAtomically(this.deviceRequestsFile(), [
      ...this.deviceRequestsByKey.values(),
    ]);
    if (fs.existsSync(this.deliveryDir())) {
      for (const name of fs.readdirSync(this.deliveryDir())) {
        if (!name.endsWith(".jsonl")) continue;
        const file = path.join(this.deliveryDir(), name);
        const retained: DurableRuntimeEvent[] = [];
        let parsedEventCount = 0;
        for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const parsed: unknown = JSON.parse(line);
            if (!isRuntimeEvent(parsed)) continue;
            parsedEventCount += 1;
            if (!this.eventWasDeleted(parsed)) retained.push(parsed);
          } catch {
            // Compaction also repairs a torn tail.
          }
        }
        if (retained.length !== parsedEventCount) this.writeJSONLinesAtomically(file, retained);
      }
    }
    for (const runId of this.deletedRunIds) {
      fs.rmSync(this.runSnapshotFile(runId), { force: true });
    }
  }

  private nextEventId(deviceId: string): number {
    return this.eventHead(deviceId) + 1;
  }

  private persistEventHeads(): void {
    const heads: PersistedEventHeads = {};
    for (const [deviceId, head] of this.eventHeadByDevice) heads[deviceId] = head;
    this.writeJSONAtomically(this.eventHeadsFile(), heads);
  }

  private appendLineDurable(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "a", 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(value)}\n`, undefined, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private writeJSONLinesAtomically(file: string, values: unknown[]): void {
    const body =
      values.length > 0 ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "";
    this.writeBufferAtomically(file, Buffer.from(body, "utf8"));
  }

  private loadAcknowledgements(): PersistedAcknowledgements {
    const file = this.acknowledgementsFile();
    if (!fs.existsSync(file)) return {};
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: PersistedAcknowledgements = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
          out[normalizedDeviceId(key)] = Math.floor(value);
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  private loadOrCreateServerInstanceId(): string {
    const file = this.serverFile();
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { serverInstanceId?: unknown };
        if (typeof parsed.serverInstanceId === "string" && parsed.serverInstanceId.trim()) {
          return parsed.serverInstanceId.trim();
        }
      } catch {
        // Replace an unreadable metadata file below; run/delivery journals remain untouched.
      }
    }
    const serverInstanceId = crypto.randomUUID();
    this.writeJSONAtomically(file, { protocolVersion: 3, serverInstanceId });
    return serverInstanceId;
  }

  private writeJSONAtomically(file: string, value: unknown): void {
    this.writeBufferAtomically(file, Buffer.from(JSON.stringify(value), "utf8"));
  }

  private writeBufferAtomically(file: string, value: Buffer): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeSync(fd, value);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  }
}
