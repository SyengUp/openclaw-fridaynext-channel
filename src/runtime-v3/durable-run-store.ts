import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
  outcome: "accepted" | "replayed" | "conflict";
  run?: DurableRunRecord;
};

type PersistedAcknowledgements = Record<string, number>;

const terminalPhases = new Set<DurableRunPhase>(["completed", "failed", "cancelled"]);
const busyPhases = new Set<DurableRunPhase>([
  "dispatching",
  "running",
  "waitingForApproval",
  "waitingForDevice",
  "cancelPending",
  "reconciling",
]);

function normalizedDeviceId(deviceId: string): string {
  return deviceId.trim().toUpperCase();
}

function normalizedCommand(command: DurableRunCommand): DurableRunCommand {
  return {
    clientRequestId: command.clientRequestId.trim(),
    deviceId: normalizedDeviceId(command.deviceId),
    sessionKey: command.sessionKey.trim(),
    agentId: command.agentId.trim() || "main",
    text: command.text,
    attachments: [...command.attachments],
    ...(command.sessionOptions ? { sessionOptions: command.sessionOptions } : {}),
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
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalValue(command)))
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
  private readonly eventHeadByDevice = new Map<string, number>();
  private acknowledgements: PersistedAcknowledgements = {};
  private readonly listenersByDevice = new Map<
    string,
    Set<(event: DurableRuntimeEvent) => void>
  >();
  readonly serverInstanceId: string;

  constructor(private readonly rootDir: string) {
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.mkdirSync(this.deliveryDir(), { recursive: true });
    this.serverInstanceId = this.loadOrCreateServerInstanceId();
    this.loadRuns();
    this.acknowledgements = this.loadAcknowledgements();
  }

  acceptCommand(rawCommand: DurableRunCommand): AcceptCommandResult {
    const command = normalizedCommand(rawCommand);
    if (!command.clientRequestId || !command.deviceId || !command.sessionKey) {
      throw new Error("clientRequestId, deviceId and sessionKey are required");
    }
    const requestKey = this.requestKey(command.deviceId, command.clientRequestId);
    const hash = payloadHash(command);
    const existingId = this.runIdByRequest.get(requestKey);
    if (existingId) {
      const existing = this.runsById.get(existingId);
      if (!existing) throw new Error(`run ledger index is corrupt for ${existingId}`);
      return { outcome: existing.payloadHash === hash ? "replayed" : "conflict", run: existing };
    }

    const now = Date.now();
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
    return { outcome: "accepted", run: record };
  }

  run(runId: string): DurableRunRecord | undefined {
    return this.runsById.get(runId.trim());
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
    const sessionRuns = this.runs().filter((run) => run.sessionKey === current.sessionKey);
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

    let phase = current.phase;
    if (eventType === "run.started") phase = "running";
    if (eventType === "run.completed") phase = "completed";
    if (eventType === "run.failed") phase = "failed";
    if (eventType === "run.cancelled") phase = "cancelled";
    const updated: DurableRunRecord = {
      ...current,
      phase,
      lastRunSeq: runSeq,
      updatedAt: event.occurredAt,
    };
    this.persistRun(updated);
    this.runsById.set(updated.runId, updated);
    for (const listener of this.listenersByDevice.get(deviceId) ?? []) listener(event);
    return event;
  }

  subscribe(
    deviceId: string,
    listener: (event: DurableRuntimeEvent) => void,
  ): () => void {
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

  eventsAfter(deviceId: string, afterEventId: number, limit = 1_000): DurableRuntimeEvent[] {
    const file = this.deliveryFile(normalizedDeviceId(deviceId));
    if (!fs.existsSync(file)) return [];
    const events: DurableRuntimeEvent[] = [];
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRuntimeEvent(parsed) && parsed.eventId > afterEventId) events.push(parsed);
      } catch {
        // A torn final append is recoverable; earlier records remain authoritative.
      }
    }
    events.sort((a, b) => a.eventId - b.eventId);
    return events.slice(0, Math.max(0, Math.floor(limit)));
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

  acknowledge(deviceId: string, throughEventId: number): number {
    const normalized = normalizedDeviceId(deviceId);
    const bounded = Math.max(0, Math.min(Math.floor(throughEventId), this.eventHead(normalized)));
    const current = this.acknowledgements[normalized] ?? 0;
    if (bounded <= current) return current;
    this.acknowledgements = { ...this.acknowledgements, [normalized]: bounded };
    this.writeJSONAtomically(this.acknowledgementsFile(), this.acknowledgements);
    return bounded;
  }

  acknowledgedEventId(deviceId: string): number {
    return this.acknowledgements[normalizedDeviceId(deviceId)] ?? 0;
  }

  private requestKey(deviceId: string, clientRequestId: string): string {
    return `${normalizedDeviceId(deviceId)}\u0000${clientRequestId.trim()}`;
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

  private acknowledgementsFile(): string {
    return path.join(this.rootDir, "acknowledgements.json");
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
        const previous = this.runsById.get(parsed.runId);
        if (!previous || parsed.updatedAt >= previous.updatedAt) this.runsById.set(parsed.runId, parsed);
      } catch {
        // Ignore a corrupt/torn record and continue rebuilding from prior committed lines.
      }
    }
    for (const run of this.runsById.values()) {
      this.runIdByRequest.set(this.requestKey(run.deviceId, run.clientRequestId), run.runId);
    }
  }

  private persistRun(run: DurableRunRecord): void {
    this.appendLineDurable(this.runsFile(), run);
  }

  private nextEventId(deviceId: string): number {
    return this.eventHead(deviceId) + 1;
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
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(value), undefined, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  }
}
