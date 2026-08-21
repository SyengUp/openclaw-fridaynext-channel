/**
 * Optional `api.runtime.talk.openSession` capture.
 *
 * OpenClaw 2026.7.1-2 (this install) does not expose it; later hosts that ship
 * PR #112820 can skip the connId-bridge and receive PCM via the SDK callback.
 */

export type TalkSdkSessionHandle = {
  sessionId?: string;
  sendAudio: (pcm: Buffer) => void | Promise<void>;
  cancelOutput?: (reason?: string) => void | Promise<void>;
  close: () => void | Promise<void>;
};

export type TalkSdkOpenSession = (params: {
  sessionKey?: string;
  signal?: AbortSignal;
  onEvent: (event: Record<string, unknown>) => void;
}) => Promise<TalkSdkSessionHandle>;

let openSession: TalkSdkOpenSession | null = null;

export function setTalkRuntime(runtime: unknown): void {
  const talk = (runtime as { talk?: { openSession?: unknown } } | null | undefined)?.talk;
  openSession = typeof talk?.openSession === "function" ? (talk.openSession as TalkSdkOpenSession) : null;
}

export function getTalkOpenSession(): TalkSdkOpenSession | null {
  return openSession;
}

/** Vitest-only */
export function resetTalkRuntimeForTest(): void {
  openSession = null;
}
