/**
 * Per-session ring buffer of forwarded `agent` SSE frames.
 *
 * The Friday app can bind to a session it never messaged in (e.g. a conversation
 * started in OpenClaw Control UI / WebChat). OpenClaw's event bus has no
 * per-session subscription and no replay store, so the plugin keeps the last N
 * forwarded `agent` frames per session in memory. When a device binds to a
 * session (`bindFridayDeviceToSession`), the buffered frames are injected into
 * that device's durable SSE queue so the app renders an in-progress run's
 * deltas so far (or a just-finished run) even if it attached late or its
 * per-session `ChatState` was evicted. Bounded: ring per session + LRU on
 * session count, so unbounded cross-channel traffic (Control UI / WebChat /
 * Telegram) cannot grow memory without limit.
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

  resetForTest(): void {
    this.bySession.clear();
  }
}

export const sessionReplayBuffer = new SessionReplayBuffer();