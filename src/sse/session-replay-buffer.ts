/**
 * Per-session ring buffer of forwarded `agent` SSE frames.
 *
 * The Friday app can bind to a session it never messaged in (e.g. a conversation
 * started in OpenClaw Control UI / WebChat). OpenClaw's event bus has no
 * per-session subscription and no replay store, so the plugin keeps the last N
 * forwarded `agent` frames per session in memory. When a device binds to a
 * session (`bindFridayDeviceToSession`), buffered frames from unfinished runs
 * are injected into that device's durable SSE queue so the app renders an
 * in-progress run's deltas so far even if it attached late or its per-session
 * `ChatState` was evicted. Completed runs stay on the transcript/history path;
 * replaying them as live deltas makes a fresh install visibly re-stream old
 * answers. Bounded: ring per session + LRU on session count, so unbounded
 * cross-channel traffic (Control UI / WebChat / Telegram) cannot grow memory
 * without limit.
 */

export type SessionReplayFrame = {
  type: "agent";
  data: Record<string, unknown>;
};

const MAX_FRAMES_PER_SESSION = 400;
const MAX_SESSIONS = 60;

class SessionReplayBuffer {
  private readonly bySession = new Map<string, SessionReplayFrame[]>();

  append(sessionKey: string, frame: SessionReplayFrame): void {
    const key = sessionKey.trim();
    if (!key) return;
    let frames = this.bySession.get(key);
    if (!frames) {
      frames = [];
      this.bySession.set(key, frames);
    }
    frames.push(frame);
    if (frames.length > MAX_FRAMES_PER_SESSION) {
      frames.splice(0, frames.length - MAX_FRAMES_PER_SESSION);
    }
    // Re-insert so Map insertion order doubles as LRU recency.
    this.bySession.delete(key);
    this.bySession.set(key, frames);
    if (this.bySession.size > MAX_SESSIONS) {
      const oldest = this.bySession.keys().next().value;
      if (typeof oldest === "string") this.bySession.delete(oldest);
    }
  }

  framesFor(sessionKey: string): SessionReplayFrame[] {
    const key = sessionKey.trim();
    if (!key) return [];
    return this.bySession.get(key) ?? [];
  }

  /**
   * Return only runs whose buffered window has no terminal lifecycle frame.
   * Grouping by run (instead of dropping only the terminal frame) is essential:
   * otherwise the assistant/tool deltas of an already-finished run would still
   * rebuild a fake live surface when a newly installed app binds for the first
   * time. `lifecycle.end` is appended after the run's other frames, so if ring
   * trimming ever removes it, every older frame from that same run has already
   * been removed as well.
   */
  replayableFramesFor(sessionKey: string): SessionReplayFrame[] {
    const frames = this.framesFor(sessionKey);
    const terminalRunIds = new Set<string>();
    for (const frame of frames) {
      const runId = typeof frame.data.runId === "string" ? frame.data.runId.trim() : "";
      const stream = frame.data.stream;
      const nested = frame.data.data;
      if (
        runId &&
        stream === "lifecycle" &&
        nested !== null &&
        typeof nested === "object" &&
        !Array.isArray(nested)
      ) {
        const phase = (nested as Record<string, unknown>).phase;
        if (phase === "end" || phase === "error") terminalRunIds.add(runId);
      }
    }
    if (terminalRunIds.size === 0) return frames;
    return frames.filter((frame) => {
      const runId = typeof frame.data.runId === "string" ? frame.data.runId.trim() : "";
      return !runId || !terminalRunIds.has(runId);
    });
  }

  resetForTest(): void {
    this.bySession.clear();
  }
}

export const sessionReplayBuffer = new SessionReplayBuffer();
