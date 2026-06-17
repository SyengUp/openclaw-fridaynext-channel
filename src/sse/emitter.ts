import type { ServerResponse } from "node:http";
import { createFridayNextLogger } from "../logging.js";
import { fridaySseOfflineQueue } from "./offline-queue.js";

const logger = createFridayNextLogger("sse", "info");

export type SseEventType = "connected" | "agent" | "deliver" | "tool-hook" | "outbound" | "ping" | "subagent";

export interface SseEvent {
  type: SseEventType;
  data: Record<string, unknown>;
}

type BacklogEntry = {
  id: number;
  event: SseEvent;
};

export class SseConnection {
  readonly deviceId: string;
  private readonly res: ServerResponse;
  private closed = false;
  private pending: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private waitingDrain = false;

  constructor(deviceId: string, res: ServerResponse) {
    this.deviceId = deviceId;
    this.res = res;
    this.res.on("drain", () => {
      this.waitingDrain = false;
      this.scheduleFlush();
    });
    this.res.on("error", () => this.close());
  }

  send(entry: BacklogEntry | SseEvent, flushNow?: boolean): void {
    if (this.closed) return;
    const normalized =
      "id" in entry && "event" in entry ? entry : { id: Date.now(), event: entry };
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

  addConnection(deviceId: string, res: ServerResponse): SseConnection {
    const normalized = deviceId.trim().toUpperCase();
    const existing = this.connections.get(normalized);
    if (existing && !existing.isClosed) {
      existing.close();
      for (const set of this.runEmitter.values()) {
        set.delete(normalized);
      }
    }
    const conn = new SseConnection(normalized, res);
    this.connections.set(normalized, conn);
    logger.info(`connect ${normalized} total=${this.connections.size}`);
    return conn;
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
    const diskMax = fridaySseOfflineQueue.latestId(key);
    const memMax = this.eventSeqByDevice.get(key) ?? 0;
    const last = Math.max(memMax, diskMax);
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

  broadcast(event: SseEvent, deviceId?: string, flushNow?: boolean): void {
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
    const direct = typeof event.data.deviceId === "string" ? event.data.deviceId : "";
    if (direct.trim()) {
      this.broadcast(event, direct, flushNow);
      return;
    }
    const set = this.runEmitter.get(runId);
    if (!set || set.size === 0) return;
    for (const deviceId of set) this.broadcast(event, deviceId, flushNow);
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
  }
}

export const sseEmitter = new SseEmitterRegistry();
