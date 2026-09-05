import type { ServerResponse } from "node:http";
import { createFridayNextLogger } from "../logging.js";
import { fridaySseOfflineQueue } from "./offline-queue.js";
import { runtimeV3StoreIfInitialized } from "../runtime-v3/runtime-store.js";
import type { DurableRunStore } from "../runtime-v3/durable-run-store.js";

const logger = createFridayNextLogger("sse", "info");

export type SseEventType =
  | "connected"
  | "agent"
  | "deliver"
  | "tool-hook"
  | "outbound"
  | "ping"
  | "subagent"
  | "approval"
  | "session-status"
  | "session-title"
  | "talk"
  | "fridaynext-health-query"
  | "fridaynext-health-log"
  | "fridaynext-calendar-query"
  | "fridaynext-calendar-log"
  | "fridaynext-location-query";

export interface SseEvent {
  type: SseEventType;
  data: Record<string, unknown>;
}

type BacklogEntry = {
  id: number;
  event: SseEvent;
};

type PendingRuntimeDeltaBatch = {
  store: DurableRunStore;
  eventType: string;
  events: SseEvent[];
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
};

export class SseConnection {
  readonly deviceId: string;
  /** True when this SSE stream arrived over the public relay (filter-proxy marker). Drives the
   * OSS side-channel divert: LAN-connected devices keep the cheaper/faster tunnel path. */
  readonly viaPublic: boolean;
  private readonly res: ServerResponse;
  private closed = false;
  private pending: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private waitingDrain = false;

  constructor(deviceId: string, res: ServerResponse, viaPublic = false) {
    this.deviceId = deviceId;
    this.viaPublic = viaPublic;
    this.res = res;
    this.res.on("drain", () => {
      this.waitingDrain = false;
      this.scheduleFlush();
    });
    this.res.on("error", () => this.close());
  }

  send(entry: BacklogEntry | SseEvent, flushNow?: boolean): void {
    if (this.closed) return;
    const normalized = "id" in entry && "event" in entry ? entry : { id: Date.now(), event: entry };
    const payload = JSON.stringify(normalized.event.data);
    this.pending.push(
      `id: ${normalized.id}\nevent: ${normalized.event.type}\ndata: ${payload}\n\n`,
    );
    if (flushNow) {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.flush();
      return;
    }
    this.scheduleFlush();
  }

  /**
   * Push an event to this live connection without an SSE id and without the
   * durable offline queue. Used for ephemeral snapshots (session-status) that
   * must not be replayed after reconnect.
   */
  sendLive(event: SseEvent, flushNow?: boolean): void {
    if (this.closed) return;
    const payload = JSON.stringify(event.data);
    this.pending.push(`event: ${event.type}\ndata: ${payload}\n\n`);
    if (flushNow) {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.flush();
      return;
    }
    this.scheduleFlush();
  }

  sendRaw(line: string): void {
    if (this.closed) return;
    const ok = this.res.write(line);
    if (ok === false) this.waitingDrain = true;
  }

  private scheduleFlush(): void {
    if (this.waitingDrain || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 16);
  }

  private flush(): void {
    if (this.closed || this.waitingDrain || this.pending.length === 0) return;
    const data = this.pending.join("");
    this.pending = [];
    const ok = this.res.write(data);
    if (ok === false) this.waitingDrain = true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending = [];
    try {
      this.res.end();
    } catch {
      // ignore
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

class SseEmitterRegistry {
  private connections = new Map<string, SseConnection>();
  private runEmitter = new Map<string, Set<string>>();
  private lastRunIdByDevice = new Map<string, string>();
  private eventSeqByDevice = new Map<string, number>();
  private backlogLimit = 200;
  private pendingRuntimeDeltas = new Map<string, PendingRuntimeDeltaBatch>();
  /**
   * OpenClaw can transiently install the same agent-event listener twice while
   * hot-reloading a plugin. Its `(runId, seq, stream)` tuple is the durable
   * source identity, so duplicate callbacks must not mint new protocol events.
   */
  private mirroredRuntimeSourceKeysByRun = new Map<string, Set<string>>();

  private runtimeSourceKey(event: SseEvent): string | undefined {
    const sourceRunId = typeof event.data.runId === "string" ? event.data.runId.trim() : "";
    const sourceSeq = event.data.seq;
    if (!sourceRunId || typeof sourceSeq !== "number" || !Number.isFinite(sourceSeq)) {
      return undefined;
    }
    const stream = typeof event.data.stream === "string" ? event.data.stream : "";
    return `${event.type}\u0000${sourceRunId}\u0000${stream}\u0000${sourceSeq}`;
  }

  private persistedRuntimeSourceKeys(store: DurableRunStore, runId: string): Set<string> {
    const cached = this.mirroredRuntimeSourceKeysByRun.get(runId);
    if (cached) return cached;
    const keys = new Set<string>();
    for (const durableEvent of store.eventsForRun(runId)) {
      const payload = durableEvent.payload;
      const batch = payload._sourceEventBatch;
      const sources = Array.isArray(batch)
        ? batch
        : [{ type: payload._sourceEventType, data: payload._sourceEventData }];
      for (const source of sources) {
        if (!source || typeof source !== "object" || Array.isArray(source)) continue;
        const record = source as Record<string, unknown>;
        const type = record.type;
        const data = record.data;
        if (typeof type !== "string" || !data || typeof data !== "object" || Array.isArray(data)) {
          continue;
        }
        const key = this.runtimeSourceKey({ type: type as SseEventType, data: data as Record<string, unknown> });
        if (key) keys.add(key);
      }
    }
    this.mirroredRuntimeSourceKeysByRun.set(runId, keys);
    return keys;
  }

  private appendRuntimeMirror(
    store: DurableRunStore,
    runId: string,
    eventType: string,
    events: SseEvent[],
  ): void {
    const last = events.at(-1);
    if (!last) return;
    store.appendRunEvent(runId, eventType, {
      _sourceEventType: last.type,
      _sourceEventData: last.data,
      ...(events.length > 1
        ? {
            _sourceEventBatch: events.map((event) => ({
              type: event.type,
              data: event.data,
            })),
          }
        : {}),
    });
  }

  flushRuntimeV3Run(runId: string): void {
    const key = runId.trim();
    const pending = this.pendingRuntimeDeltas.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRuntimeDeltas.delete(key);
    this.appendRuntimeMirror(pending.store, key, pending.eventType, pending.events);
  }

  private enqueueRuntimeDelta(
    store: DurableRunStore,
    runId: string,
    eventType: string,
    event: SseEvent,
  ): void {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    const existing = this.pendingRuntimeDeltas.get(runId);
    // 累计全文可能很大；按字节限制批次，避免合并后超过客户端单帧缓冲上限。
    if (existing && (existing.store !== store || existing.bytes + bytes > 128 * 1024)) {
      this.flushRuntimeV3Run(runId);
    }
    const pending = this.pendingRuntimeDeltas.get(runId);
    if (pending) {
      // 同一 run 的正文/推理/候选更新可交错；原始类型和顺序保存在 batch 中。
      pending.eventType = eventType;
      pending.bytes += bytes;
      pending.events.push(event);
      if (pending.events.length >= 32) this.flushRuntimeV3Run(runId);
      return;
    }
    const timer = setTimeout(() => this.flushRuntimeV3Run(runId), 16);
    timer.unref();
    this.pendingRuntimeDeltas.set(runId, {
      store,
      eventType,
      events: [event],
      bytes,
      timer,
    });
  }

  private mirrorIntoRuntimeV3(event: SseEvent, hintedRunId?: string): void {
    const store = runtimeV3StoreIfInitialized();
    if (!store) return;
    const rawRunId = hintedRunId ?? event.data.runId;
    const runId = typeof rawRunId === "string" ? rawRunId.trim() : "";
    if (!runId || !store.run(runId)) return;
    const sourceKey = this.runtimeSourceKey(event);
    if (sourceKey) {
      const seen = this.persistedRuntimeSourceKeys(store, runId);
      if (seen.has(sourceKey)) return;
      seen.add(sourceKey);
    }
    const phase = typeof event.data.phase === "string" ? event.data.phase.toLowerCase() : "";
    const stream = typeof event.data.stream === "string" ? event.data.stream.toLowerCase() : "";
    const dataRecord =
      event.data.data && typeof event.data.data === "object" && !Array.isArray(event.data.data)
        ? (event.data.data as Record<string, unknown>)
        : null;
    const nestedPhase =
      typeof dataRecord?.phase === "string" ? dataRecord.phase.toLowerCase() : phase;
    let eventType: string = event.type;
    if (event.type === "agent") {
      if (stream === "lifecycle" && nestedPhase === "start") eventType = "run.started";
      else if (stream === "lifecycle" && nestedPhase === "end") eventType = "run.completed";
      else if (stream === "lifecycle" && nestedPhase === "error") eventType = "run.failed";
      else eventType = `agent.${stream || "event"}.${nestedPhase || "update"}`;
    } else if (event.type === "deliver") {
      const kind = typeof event.data.kind === "string" ? event.data.kind.toLowerCase() : "event";
      eventType = `deliver.${kind}`;
    } else if (event.type === "outbound") {
      const op = typeof event.data.op === "string" ? event.data.op.toLowerCase() : "event";
      eventType = op === "dispatch_error" ? "run.failed" : `outbound.${op}`;
    } else if (event.type === "tool-hook") {
      eventType = `tool.${phase || "update"}`;
    } else if (event.type === "subagent") {
      eventType = `subagent.${phase || "update"}`;
    } else if (event.type === "approval") {
      const op = typeof event.data.op === "string" ? event.data.op.toLowerCase() : "update";
      eventType = `approval.${op}`;
    } else if (event.type === "fridaynext-health-query") {
      eventType = "device.health.request";
    } else if (event.type === "fridaynext-health-log") {
      eventType = "device.health.request";
    } else if (event.type === "fridaynext-calendar-query") {
      eventType = "device.calendar.request";
    } else if (event.type === "fridaynext-calendar-log") {
      eventType = "device.calendar.request";
    } else if (event.type === "fridaynext-location-query") {
      eventType = "device.location.request";
    }
    // 现场 assistant 带 delta 字段却没有 phase，被映射为 .update；不能只看事件名后缀。
    // 仅合并可追加的文本更新及明确隐藏的候选进度，工具和生命周期仍作为顺序屏障。
    const textUpdate = event.type === "agent"
      && ["assistant", "thinking", "reasoning"].includes(stream)
      && (nestedPhase === "" || nestedPhase === "update" || nestedPhase === "delta")
      && typeof dataRecord?.delta === "string";
    const hiddenCandidateUpdate = event.type === "agent"
      && stream === "item" && nestedPhase === "update"
      && dataRecord?.hideFromChannelProgress === true
      && dataRecord?.kind === "answer_candidate";
    if (eventType.endsWith(".delta") || textUpdate || hiddenCandidateUpdate) {
      this.enqueueRuntimeDelta(store, runId, eventType, event);
      return;
    }
    this.flushRuntimeV3Run(runId);
    this.appendRuntimeMirror(store, runId, eventType, [event]);
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  setBacklogLimit(limit: number): void {
    this.backlogLimit = Math.max(0, Math.floor(limit));
  }

  getBacklogLimit(): number {
    return this.backlogLimit;
  }

  /** Last persisted / assigned SSE id for device (for `connected.lastSeq`). */
  latestSeqForDevice(deviceId: string): number {
    const key = deviceId.trim().toUpperCase();
    const disk = fridaySseOfflineQueue.latestId(key);
    const mem = this.eventSeqByDevice.get(key) ?? 0;
    return Math.max(disk, mem);
  }

  addConnection(deviceId: string, res: ServerResponse, viaPublic = false): SseConnection {
    const normalized = deviceId.trim().toUpperCase();
    const existing = this.connections.get(normalized);
    if (existing && !existing.isClosed) {
      existing.close();
      for (const set of this.runEmitter.values()) {
        set.delete(normalized);
      }
    }
    const conn = new SseConnection(normalized, res, viaPublic);
    this.connections.set(normalized, conn);
    logger.info(`connect ${normalized} viaPublic=${viaPublic} total=${this.connections.size}`);
    return conn;
  }

  /** True when the device's LIVE SSE stream arrived over the public relay. LAN-connected and
   * offline devices are false — outbound media for them stays on the tunnel path (cheaper, and a
   * tunnel URL is fetchable from either origin once the device reconnects). */
  isDeviceOnPublicSurface(deviceId: string): boolean {
    const conn = this.connections.get(deviceId.trim().toUpperCase());
    return conn !== undefined && !conn.isClosed && conn.viaPublic;
  }

  /**
   * @param expectedConn When provided, only removes if this connection is still the active one
   * (avoids stale `req.close` after a reconnect replaced the map entry).
   */
  removeConnection(deviceId: string, expectedConn?: SseConnection): void {
    const normalized = deviceId.trim().toUpperCase();
    const current = this.connections.get(normalized);
    if (expectedConn !== undefined && current !== expectedConn) {
      return;
    }
    current?.close();
    this.connections.delete(normalized);
    for (const set of this.runEmitter.values()) set.delete(normalized);
    logger.info(`disconnect ${normalized} total=${this.connections.size}`);
  }

  getConnection(deviceId: string): SseConnection | undefined {
    return this.connections.get(deviceId.trim().toUpperCase());
  }

  private nextEntry(deviceId: string, event: SseEvent): BacklogEntry {
    const key = deviceId.trim().toUpperCase();
    // 内存序号一旦建立就是权威的（本进程是该队列文件的唯一写者），此后不再扫盘。
    // 此前每个事件都要 latestId() → 全文件读 + 逐行 JSON.parse，长回答的每个 delta 都付一次。
    // 进程重启后 map 为空 → 首个事件仍与磁盘对齐一次，Last-Event-ID 续传不受影响。
    let last = this.eventSeqByDevice.get(key);
    if (last === undefined) {
      last = fridaySseOfflineQueue.latestId(key);
    }
    const id = last + 1;
    this.eventSeqByDevice.set(key, id);
    fridaySseOfflineQueue.append(key, id, event.type, event.data, this.backlogLimit);
    return { id, event };
  }

  replayBacklog(deviceId: string, afterEventId: number): number {
    const key = deviceId.trim().toUpperCase();
    const conn = this.connections.get(key);
    if (!conn) return 0;
    const entries = fridaySseOfflineQueue.readAfter(key, afterEventId);
    let count = 0;
    for (const e of entries) {
      conn.send({ id: e.id, event: { type: e.event as SseEventType, data: e.data } }, true);
      count += 1;
    }
    return count;
  }

  broadcast(
    event: SseEvent,
    deviceId?: string,
    flushNow?: boolean,
    skipRuntimeMirror = false,
  ): void {
    if (!skipRuntimeMirror) this.mirrorIntoRuntimeV3(event);
    if (deviceId) {
      const key = deviceId.trim().toUpperCase();
      const entry = this.nextEntry(key, event);
      this.connections.get(key)?.send(entry, flushNow);
      return;
    }
    for (const conn of this.connections.values()) {
      const entry = this.nextEntry(conn.deviceId, event);
      conn.send(entry, flushNow);
    }
  }

  /**
   * Fan out to every live SSE connection without assigning an id or appending
   * the durable per-device queue. Reconnects get a fresh snapshot on `connected`.
   */
  broadcastLive(event: SseEvent, flushNow?: boolean): void {
    for (const conn of this.connections.values()) {
      conn.sendLive(event, flushNow);
    }
  }

  /**
   * Same as `broadcastLive` but only the named device. Talk audio deltas use this
   * so PCM never lands in the durable backlog (useless after reconnect, huge).
   */
  broadcastLiveToDevice(event: SseEvent, deviceId: string, flushNow?: boolean): void {
    const key = deviceId.trim().toUpperCase();
    if (!key) return;
    this.connections.get(key)?.sendLive(event, flushNow);
  }

  trackDeviceForRun(deviceId: string, runId: string): void {
    const key = deviceId.trim().toUpperCase();
    const set = this.runEmitter.get(runId) ?? new Set<string>();
    set.add(key);
    this.runEmitter.set(runId, set);
    this.lastRunIdByDevice.set(key, runId);
  }

  untrackRun(runId: string): void {
    this.runEmitter.delete(runId);
  }

  hasTrackedDevices(runId: string): boolean {
    return (this.runEmitter.get(runId)?.size ?? 0) > 0;
  }

  getDeviceIdByRunId(runId: string): string | null {
    const first = this.runEmitter.get(runId)?.values().next().value;
    return typeof first === "string" ? first : null;
  }

  getSoleConnectedDeviceId(): string | null {
    if (this.connections.size !== 1) return null;
    return this.connections.keys().next().value ?? null;
  }

  getLastRunIdForDevice(deviceId: string): string | null {
    return this.lastRunIdByDevice.get(deviceId.trim().toUpperCase()) ?? null;
  }

  broadcastToRun(runId: string, event: SseEvent, flushNow?: boolean): void {
    this.mirrorIntoRuntimeV3(event, runId);
    const direct = typeof event.data.deviceId === "string" ? event.data.deviceId : "";
    if (direct.trim()) {
      this.broadcast(event, direct, flushNow, true);
      return;
    }
    const set = this.runEmitter.get(runId);
    if (!set || set.size === 0) return;
    for (const deviceId of set) this.broadcast(event, deviceId, flushNow, true);
  }

  broadcastToolEvent(deviceId: string, runId: string, event: SseEvent, flushNow?: boolean): void {
    this.trackDeviceForRun(deviceId, runId);
    this.broadcastToRun(runId, event, flushNow ?? true);
  }

  /** Vitest / e2e: drop connections and in-memory seq maps (does not delete disk queue files). */
  resetForTest(): void {
    for (const c of this.connections.values()) c.close();
    this.connections.clear();
    this.runEmitter.clear();
    this.lastRunIdByDevice.clear();
    this.eventSeqByDevice.clear();
    for (const pending of this.pendingRuntimeDeltas.values()) clearTimeout(pending.timer);
    this.pendingRuntimeDeltas.clear();
    this.mirroredRuntimeSourceKeysByRun.clear();
  }
}

export const sseEmitter = new SseEmitterRegistry();
