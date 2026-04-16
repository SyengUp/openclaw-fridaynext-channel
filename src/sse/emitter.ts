import type { ServerResponse } from "node:http";

const log = (action: string, runId: string, detail?: string) => {
  const ts = new Date().toISOString();
  const detailPart = detail ? ` detail=${detail}` : "";
  console.error(`[Friday-EMIT] [${ts}] [${action}] runId=${runId}${detailPart}`);
};

export type SseEventType =
  | "reasoning"
  | "final"
  | "attachment"
  /** Synthetic speech (OpenClaw auto-TTS, `tts` tool, or outbound audio). Same `data` shape as `attachment` unless noted. */
  | "tts"
  | "tool"
  | "agent"
  | "run-complete"
  | "run-error";

export interface SseEvent {
  type: SseEventType;
  data: Record<string, unknown>;
}

/** Per-deviceId SSE connection with buffered flush. */
class SseConnection {
  readonly deviceId: string;
  private res: ServerResponse;
  private closed = false;
  private pending: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private waitingDrain = false;

  constructor(deviceId: string, res: ServerResponse) {
    this.deviceId = deviceId;
    this.res = res;
    // Handle socket backpressure: when write() returns false, wait for drain
    this.res.on("drain", () => {
      this.waitingDrain = false;
      log("DRAIN", this.deviceId, `buffer-drained, pending=${this.pending.length}`);
      // Any data that caused backpressure is already in Node.js write buffer and
      // will be flushed by the OS. Just resume normal scheduling.
      this.scheduleFlush();
    });
    this.res.on("error", (err: Error) => {
      log("SOCKET_ERROR", this.deviceId, `error=${err.message}`);
      this.close();
    });
  }

  send(event: SseEvent, flushNow?: boolean): void {
    if (this.closed) {
      log("SEND_SKIPPED", this.deviceId, `type=${event.type} conn-closed`);
      return;
    }
    const payload = JSON.stringify({ type: event.type, ...event.data });
    log("SEND_QUEUED", this.deviceId, `type=${event.type} pendingBefore=${this.pending.length}`);
    // Plain JSON per line (no SSE data: prefix — easier for iOS to parse)
    this.pending.push(`${payload}\n`);
    if (flushNow) {
      // Bypass 16ms batch timer — flush immediately for streaming final text
      if (this.flushTimer !== null) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  /** Send a raw SSE line immediately, bypassing the event queue. */
  sendRaw(line: string): void {
    if (this.closed) {
      log("SEND_SKIPPED", this.deviceId, `raw conn-closed`);
      return;
    }
    try {
      const ok = this.res.write(line);
      if (ok === false) {
        this.waitingDrain = true;
        log("WRITE_BACKPRESSURE", this.deviceId, `raw pending=1 awaiting-drain`);
      } else {
        log("WRITE_OK", this.deviceId, `raw bytes=${line.length}`);
      }
    } catch (err: unknown) {
      log("WRITE_ERROR", this.deviceId, String(err));
      this.close();
    }
  }

  private scheduleFlush(): void {
    // Don't schedule if waiting for drain or already scheduled
    if (this.waitingDrain || this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 16); // ~60fps flush
  }

  private flush(): void {
    if (this.closed) {
      log("FLUSH_SKIPPED", this.deviceId, `conn-closed`);
      return;
    }
    if (this.pending.length === 0) {
      log("FLUSH_SKIPPED", this.deviceId, `no-pending`);
      return;
    }
    // If socket buffer is full, wait for drain
    if (this.waitingDrain) {
      log("FLUSH_DEFERRED", this.deviceId, `backpressure pending=${this.pending.length}`);
      return;
    }

    const data = this.pending.join("");
    try {
      const ok = this.res.write(data);
      // Important: once write() is called, data is handed to Node's socket buffer.
      // We must clear pending regardless of ok to avoid duplicate re-flush after drain.
      this.pending = [];
      if (ok === false) {
        // Socket buffer full — stop scheduling flushes until drain
        this.waitingDrain = true;
        log("WRITE_BACKPRESSURE", this.deviceId, `buffer-full pending=0 awaiting-drain`);
      } else {
        log("WRITE_OK", this.deviceId, `bytes=${data.length} pending=0`);
      }
    } catch (err: unknown) {
      log("WRITE_ERROR", this.deviceId, String(err));
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pending = [];
    try {
      this.res.end();
      log("CONN_CLOSE", this.deviceId);
    } catch {
      // Already ended
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/** Per-run state for accumulation and sequencing. */
interface RunState {
  reasoningStarted: boolean;
  reasoningEnded: boolean;
  finalStarted: boolean;
  finalEnded: boolean;
  /** Explicit reasoning segment from runner: seq with open start, closed by end or final. */
  reasoningOpenSeq: number | null;
}

/** Global SSE emitter registry, keyed by deviceId. */
class SseEmitterRegistry {
  private connections = new Map<string, SseConnection>();
  private runEmitter = new Map<string, Set<string>>(); // runId → deviceIds
  private runStates = new Map<string, RunState>(); // runId → state
  /** Latest runId registered per device (e.g. for outbound sendMedia → attachment). */
  private lastRunIdByDevice = new Map<string, string>();

  /** Active GET /friday/events sockets (Control UI “已连接”). */
  getConnectionCount(): number {
    return this.connections.size;
  }

  addConnection(deviceId: string, res: ServerResponse): SseConnection {
    // Normalize to uppercase so tool hook broadcasts (which uppercase deviceId) find the connection
    const normalizedId = deviceId.toUpperCase();
    const conn = new SseConnection(normalizedId, res);
    this.connections.set(normalizedId, conn);
    log("CONN_ADD", deviceId, `total=${this.connections.size}`);
    return conn;
  }

  removeConnection(deviceId: string): void {
    const normalizedId = deviceId.toUpperCase();
    const conn = this.connections.get(normalizedId);
    if (conn) {
      conn.close();
      this.connections.delete(normalizedId);
      log("CONN_REMOVE", deviceId, `remaining=${this.connections.size}`);
    }
    for (const deviceIds of this.runEmitter.values()) {
      deviceIds.delete(normalizedId);
    }
  }

  broadcast(event: SseEvent, deviceId?: string, flushNow?: boolean): void {
    if (deviceId) {
      const conn = this.connections.get(deviceId.toUpperCase());
      if (conn) conn.send(event, flushNow);
      return;
    }
    for (const conn of this.connections.values()) {
      conn.send(event, flushNow);
    }
  }

  /**
   * Broadcast an event to all devices tracking a run.
   * - reasoning: legacy streams get phase=start/delta/end; events with phase+seq pass through (per-segment lifecycle)
   * - final: adds phase=start/delta/end markers; done=true signals phase=end
   * - agent/run-complete/run-error/tool/tts: forwarded as-is via runEmitter
   *
   * deviceId is extracted from event.data.deviceId and used to send directly
   * to the matching SSE connection. This avoids the need for the SSE handler
   * to pre-register with trackDeviceForRun.
   */
  broadcastToRun(runId: string, event: SseEvent, flushNow?: boolean): void {
    const deviceId = event.data["deviceId"] as string | undefined;
    const deviceIds = this.runEmitter.get(runId);

    // Send to the device's SSE connection directly using deviceId from event data.
    if (deviceId) {
      const conn = this.connections.get(deviceId.toUpperCase());
      if (conn) {
        log("BROADCAST_SEND", runId, `event=${event.type} deviceId=${deviceId} direct`);
        conn.send(event, true); // flush immediately for direct sends
        // If this run has no registered deviceIds set, we're done
        if (!deviceIds || deviceIds.size === 0) {
          log("BROADCAST_DONE", runId, `direct-sent only, no runEmitter entry`);
          return;
        }
      } else {
        log("BROADCAST_SKIP", runId, `event=${event.type} deviceId=${deviceId} conn=NONE activeConns=${[...this.connections.keys()].join(",")}`);
      }
    }

    if (!deviceIds) {
      log("BROADCAST_SKIP", runId, `event=${event.type} no runEmitter entry`);
      return;
    }

    let state = this.runStates.get(runId);
    if (!state) {
      state = {
        reasoningStarted: false,
        reasoningEnded: false,
        finalStarted: false,
        finalEnded: false,
        reasoningOpenSeq: null,
      };
      this.runStates.set(runId, state);
    }

    if (event.type === "reasoning") {
      const done = event.data["done"] === true;
      const text = (event.data["text"] as string) ?? "";
      const phase = event.data["phase"] as string | undefined;
      const seqRaw = event.data["seq"];

      // Explicit segment lifecycle from Friday runner (start / delta / end + seq)
      if (phase === "start" || phase === "delta" || phase === "end") {
        if (phase === "start" && typeof seqRaw === "number") {
          if (state.reasoningOpenSeq !== null && state.reasoningOpenSeq !== seqRaw) {
            log("BROADCAST_SEND", runId, `reasoning phase=end (implicit) seq=${state.reasoningOpenSeq} before new start`);
            this.sendToDevices(
              deviceIds,
              {
                type: "reasoning",
                data: { phase: "end", seq: state.reasoningOpenSeq, runId, timestamp: Date.now() },
              },
              true,
            );
          }
          state.reasoningOpenSeq = seqRaw;
        }
        if (phase === "end") {
          state.reasoningOpenSeq = null;
        }
        const dataOut: Record<string, unknown> = {
          ...event.data,
          runId: (event.data["runId"] as string) ?? runId,
          timestamp: (event.data["timestamp"] as number) ?? Date.now(),
        };
        const flush = flushNow === true || phase === "start" || phase === "end";
        log("BROADCAST_SEND", runId, `reasoning explicit phase=${phase} seq=${String(seqRaw)}`);
        this.sendToDevices(deviceIds, { type: "reasoning", data: dataOut }, flush);
        return;
      }

      if (done) {
        if (state.reasoningOpenSeq !== null) {
          log("BROADCAST_SEND", runId, `reasoning phase=end (done) seq=${state.reasoningOpenSeq}`);
          this.sendToDevices(
            deviceIds,
            {
              type: "reasoning",
              data: {
                phase: "end",
                seq: state.reasoningOpenSeq,
                runId,
                timestamp: Date.now(),
              },
            },
            true,
          );
          state.reasoningOpenSeq = null;
        }
        // Send start if never sent (tool-only with no reasoning), then end
        if (!state.reasoningStarted) {
          state.reasoningStarted = true;
          log("BROADCAST_SEND", runId, `reasoning phase=start (implicit)`);
          this.sendToDevices(deviceIds, {
            type: "reasoning",
            data: { phase: "start", runId, timestamp: Date.now() },
          });
        }
        if (!state.reasoningEnded) {
          state.reasoningEnded = true;
          log("BROADCAST_SEND", runId, `reasoning phase=end`);
          this.sendToDevices(deviceIds, {
            type: "reasoning",
            data: { phase: "end", runId, timestamp: Date.now() },
          });
        }
        return;
      }

      if (!state.reasoningStarted) {
        state.reasoningStarted = true;
        log("BROADCAST_SEND", runId, `reasoning phase=start`);
        this.sendToDevices(deviceIds, {
          type: "reasoning",
          data: { phase: "start", runId, timestamp: Date.now() },
        });
      }

      log("BROADCAST_SEND", runId, `reasoning phase=delta textLen=${text.length}`);
      this.sendToDevices(deviceIds, {
        type: "reasoning",
        data: { phase: "delta", text, runId },
      });
      return;
    }

    if (event.type === "final") {
      const done = event.data["done"] === true;
      const text = (event.data["text"] as string) ?? "";

      if (done) {
        if (state.reasoningOpenSeq !== null) {
          log("BROADCAST_SEND", runId, `reasoning phase=end (final done) seq=${state.reasoningOpenSeq}`);
          this.sendToDevices(
            deviceIds,
            {
              type: "reasoning",
              data: {
                phase: "end",
                seq: state.reasoningOpenSeq,
                runId,
                timestamp: Date.now(),
              },
            },
            true,
          );
          state.reasoningOpenSeq = null;
        }
        if (!state.finalEnded) {
          state.finalEnded = true;
          log("BROADCAST_SEND", runId, `final phase=end`);
          this.sendToDevices(deviceIds, {
            type: "final",
            data: { phase: "end", runId, timestamp: Date.now() },
          });
        }
        return;
      }

      // Close reasoning before starting final
      if (!state.finalStarted) {
        if (state.reasoningOpenSeq !== null) {
          log("BROADCAST_SEND", runId, `reasoning phase=end (final started) seq=${state.reasoningOpenSeq}`);
          this.sendToDevices(
            deviceIds,
            {
              type: "reasoning",
              data: {
                phase: "end",
                seq: state.reasoningOpenSeq,
                runId,
                timestamp: Date.now(),
              },
            },
            true,
          );
          state.reasoningOpenSeq = null;
        }
        if (state.reasoningStarted && !state.reasoningEnded) {
          state.reasoningEnded = true;
          log("BROADCAST_SEND", runId, `reasoning phase=end (final started)`);
          this.sendToDevices(deviceIds, {
            type: "reasoning",
            data: { phase: "end", runId, timestamp: Date.now() },
          });
        }
        state.finalStarted = true;
        log("BROADCAST_SEND", runId, `final phase=start`);
        this.sendToDevices(deviceIds, {
          type: "final",
          data: { phase: "start", runId, timestamp: Date.now() },
        });
      }

      log("BROADCAST_SEND", runId, `final phase=delta textLen=${text.length} flushNow=${flushNow}`);
      this.sendToDevices(deviceIds, {
        type: "final",
        data: { phase: "delta", text, runId },
      }, flushNow);
      return;
    }

    // agent/run-complete/run-error/tool: via runEmitter
    const urgent =
      flushNow === true ||
      event.type === "run-error" ||
      event.type === "run-complete" ||
      event.type === "tts" ||
      event.type === "attachment";
    log("BROADCAST_SEND", runId, `event=${event.type} via runEmitter size=${deviceIds.size} flushNow=${urgent}`);
    for (const id of deviceIds) {
      const conn = this.connections.get(id.toUpperCase());
      if (conn) conn.send(event, urgent);
    }
  }

  private sendToDevices(deviceIds: Set<string>, event: SseEvent, flushNow?: boolean): void {
    for (const id of deviceIds) {
      const conn = this.connections.get(id.toUpperCase());
      if (conn) {
        log("SEND_TO_DEVICE", "N/A", `event=${event.type} deviceId=${id}`);
        conn.send(event, flushNow);
      }
    }
  }

  trackDeviceForRun(deviceId: string, runId: string): void {
    const normalizedId = deviceId.toUpperCase();
    let deviceIds = this.runEmitter.get(runId);
    if (!deviceIds) {
      deviceIds = new Set();
      this.runEmitter.set(runId, deviceIds);
    }
    deviceIds.add(normalizedId);
    this.lastRunIdByDevice.set(normalizedId, runId);
    log("TRACK_RUN", runId, `deviceId=${deviceId} runEmitterSize=${this.runEmitter.size}`);
  }

  /** Most recent runId for this device from `trackDeviceForRun` (same HTTP message turn). */
  getLastRunIdForDevice(deviceId: string): string | undefined {
    return this.lastRunIdByDevice.get(deviceId.toUpperCase());
  }

  untrackRun(runId: string): void {
    log("UNTRACK_RUN", runId);
    this.runEmitter.delete(runId);
    this.runStates.delete(runId);
  }

  getConnection(deviceId: string): SseConnection | undefined {
    return this.connections.get(deviceId.toUpperCase());
  }

  /**
   * When exactly one device has an active SSE connection, return its id.
   * Used for outbound delivery when the gateway passes placeholder `to: "friday"` (channel id)
   * instead of a real device UUID — e.g. cron jobs that declare channel but no explicit peer.
   */
  getSoleConnectedDeviceId(): string | undefined {
    if (this.connections.size !== 1) return undefined;
    return [...this.connections.keys()][0];
  }

  /**
   * Broadcast an SSE line directly to a device's SSE connection, bypassing SseEvent wrapping.
   * Used for attachment events where the iOS app expects flat-field JSON (not nested data{}).
   */
  broadcastSseLine(deviceId: string, payload: Record<string, unknown>): void {
    const conn = this.connections.get(deviceId.toUpperCase());
    if (!conn) {
      log("SSE_LINE_SKIP", deviceId, `conn=NONE activeConns=${[...this.connections.keys()].join(",")}`);
      return;
    }
    const line = JSON.stringify(payload) + "\n";
    log("SSE_LINE_SEND", deviceId, `len=${line.length}`);
    conn.sendRaw(line);
  }

  /**
   * Broadcast a tool event to the device identified by deviceId.
   * Used by before_tool_call and after_tool_call plugin hooks.
   */
  broadcastToolEvent(deviceId: string | null, runId: string, event: SseEvent, flushNow?: boolean): void {
    if (!deviceId) {
      log("TOOL_BROADCAST_SKIP", runId, `deviceId=null`);
      return;
    }
    const conn = this.connections.get(deviceId.toUpperCase());
    if (!conn) {
      log("TOOL_BROADCAST_SKIP", runId, `deviceId=${deviceId} conn=NONE activeConns=${[...this.connections.keys()].join(",")}`);
      return;
    }
    log("TOOL_BROADCAST", runId, `type=${event.type} deviceId=${deviceId} flushNow=${flushNow}`);
    conn.send(event, flushNow);
  }

  /**
   * Look up the deviceId for a given runId by scanning runEmitter entries.
   * Used by plugin hooks that receive runId but not deviceId.
   *
   * After `notifyRunComplete` → `untrackRun`, the run is removed from `runEmitter` but
   * `lastRunIdByDevice` still maps the device to that runId — tools that finish slightly
   * late (e.g. `exec`) would otherwise see `SKIP_no_deviceId`.
   */
  getDeviceIdByRunId(runId: string): string | null {
    const deviceIds = this.runEmitter.get(runId);
    if (deviceIds && deviceIds.size > 0) {
      return [...deviceIds][0] ?? null;
    }
    for (const [deviceId, rid] of this.lastRunIdByDevice) {
      if (rid === runId) return deviceId;
    }
    return null;
  }
}

// Singleton instance
const globalEmitter = new SseEmitterRegistry();
export { globalEmitter as sseEmitter, SseConnection };
