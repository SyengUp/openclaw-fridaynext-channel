import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bindFridayDeviceToSession,
  forwardAgentEventRaw,
  registerFridaySessionDeviceMapping,
  resetOpenClawRunDeviceMappingForTest,
  resetSessionBindingsForTest,
  setLastDeviceStateFileForTest,
  setSessionBindStateFileForTest,
  watchedDevicesForSessionKey,
} from "./friday-session.js";
import { sessionReplayBuffer } from "./sse/session-replay-buffer.js";
import { sseEmitter } from "./sse/emitter.js";
import { resetActiveRunsForTest } from "./agent/active-runs.js";
import { resetRunMetadataForTest } from "./run-metadata.js";
import { resetFridayAgentForwardRuntimeForTest } from "./agent-forward-runtime.js";

describe("session bind (watch a conversation started elsewhere)", () => {
  const sessionKey = "agent:main:control-ui-session";
  const ownerDevice = "11111111-2222-3333-4444-555555555555";
  const watcherDevice = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

  beforeEach(() => {
    sseEmitter.resetForTest();
    sessionReplayBuffer.resetForTest();
    resetSessionBindingsForTest();
    resetOpenClawRunDeviceMappingForTest();
    resetFridayAgentForwardRuntimeForTest();
    resetRunMetadataForTest();
    resetActiveRunsForTest();
    setLastDeviceStateFileForTest(null);
    setSessionBindStateFileForTest(null);
    vi.spyOn(sseEmitter, "broadcastToRun").mockImplementation(() => {});
    vi.spyOn(sseEmitter, "broadcast").mockImplementation(() => {});
  });

  afterEach(() => {
    resetFridayAgentForwardRuntimeForTest();
    vi.restoreAllMocks();
  });

  const lifecycleStart = () =>
    forwardAgentEventRaw({
      runId: "run-1",
      seq: 1,
      ts: 100,
      stream: "lifecycle",
      sessionKey,
      data: { phase: "start" },
    });
  const delta = (seq: number, text: string) =>
    forwardAgentEventRaw({
      runId: "run-1",
      seq,
      ts: 100 + seq,
      stream: "assistant",
      sessionKey,
      data: { text, delta: text },
    });
  const lifecycleEnd = (seq: number) =>
    forwardAgentEventRaw({
      runId: "run-1",
      seq,
      ts: 100 + seq,
      stream: "lifecycle",
      sessionKey,
      data: { phase: "end" },
    });

  it("buffers frames of an un-owned session and replays them into the device on bind", () => {
    // No device ever POSTed to this session (Control UI conversation).
    lifecycleStart();
    delta(2, "hello");
    delta(3, "hello world");
    lifecycleEnd(4);

    expect(sseEmitter.broadcastToRun).not.toHaveBeenCalled();
    expect(sessionReplayBuffer.framesFor(sessionKey)).toHaveLength(4);

    const replayed = bindFridayDeviceToSession(sessionKey, watcherDevice);
    expect(replayed).toBe(4);
    // Replay frames were injected into the watcher's durable SSE queue.
    const broadcastCalls = (sseEmitter.broadcast as ReturnType<typeof vi.fn>).mock.calls;
    expect(broadcastCalls).toHaveLength(4);
    for (const call of broadcastCalls) {
      expect(call[1]).toBe(watcherDevice);
      expect(call[0].type).toBe("agent");
      expect(call[0].data.sessionKey).toBe(sessionKey);
    }
    expect(broadcastCalls[0][0].data.seq).toBe(1);
    expect(broadcastCalls[3][0].data.seq).toBe(4);
  });

  it("forwards a bound session's live frames to the bound device (owner path)", () => {
    bindFridayDeviceToSession(sessionKey, watcherDevice);
    (sseEmitter.broadcast as ReturnType<typeof vi.fn>).mockClear();

    delta(2, "live");

    expect(sseEmitter.broadcastToRun).toHaveBeenCalledTimes(1);
    const frame = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(frame.type).toBe("agent");
    expect(frame.data.sessionKey).toBe(sessionKey);
    expect(frame.data.data.text).toBe("live");
  });

  it("sends the stream to additional bound devices when the owner differs", () => {
    registerFridaySessionDeviceMapping(sessionKey, ownerDevice);
    bindFridayDeviceToSession(sessionKey, watcherDevice);
    (sseEmitter.broadcast as ReturnType<typeof vi.fn>).mockClear();

    delta(2, "shared");

    // Owner path → owner device.
    expect(sseEmitter.broadcastToRun).toHaveBeenCalledTimes(1);
    const ownerFrame = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(ownerFrame.data.deviceId).toBe(ownerDevice);
    // Watched broadcast → the bound watcher (not the owner, which already got it).
    const calls = (sseEmitter.broadcast as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe(watcherDevice);
    expect(calls[0][0].data.sessionKey).toBe(sessionKey);
  });

  it("does not double-send to the owner when it is also bound", () => {
    registerFridaySessionDeviceMapping(sessionKey, ownerDevice);
    bindFridayDeviceToSession(sessionKey, ownerDevice);
    (sseEmitter.broadcast as ReturnType<typeof vi.fn>).mockClear();

    delta(2, "owner-only");

    expect(sseEmitter.broadcastToRun).toHaveBeenCalledTimes(1);
    expect(sseEmitter.broadcast).not.toHaveBeenCalled();
  });

  it("does not buffer suppressed item frames, so bind replays nothing for them", () => {
    forwardAgentEventRaw({
      runId: "run-suppressed",
      seq: 1,
      stream: "item",
      sessionKey,
      data: { kind: "tool", suppressChannelProgress: true },
    });

    expect(sseEmitter.broadcastToRun).not.toHaveBeenCalled();
    expect(sessionReplayBuffer.framesFor(sessionKey)).toHaveLength(0);
    expect(bindFridayDeviceToSession(sessionKey, watcherDevice)).toBe(0);
  });

  it("buffers hidden runs whose sessionKey is recovered from the run-context bridge", () => {
    // Simulate a Control-UI-hidden run: no sessionKey on the payload; the
    // run-context bridge resolves it. With no device mapped the frames are
    // buffered (not dropped), and a later bind replays them.
    const stateKey = Symbol.for("openclaw.agentEvents.state");
    const previous = (globalThis as Record<PropertyKey, unknown>)[stateKey];
    (globalThis as Record<PropertyKey, unknown>)[stateKey] = {
      runContextById: new Map([["run-hidden", { sessionKey }]]),
    };
    try {
      forwardAgentEventRaw({
        runId: "run-hidden",
        seq: 1,
        stream: "assistant",
        data: { text: "hidden reply", delta: "hidden reply" },
      });

      expect(sessionReplayBuffer.framesFor(sessionKey)).toHaveLength(1);
      expect(sseEmitter.broadcastToRun).not.toHaveBeenCalled();
      expect(bindFridayDeviceToSession(sessionKey, watcherDevice)).toBe(1);
    } finally {
      if (previous === undefined) {
        delete (globalThis as Record<PropertyKey, unknown>)[stateKey];
      } else {
        (globalThis as Record<PropertyKey, unknown>)[stateKey] = previous;
      }
    }
  });

  it("persists bindings and restores them after an in-memory reset (gateway restart)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-bind-"));
    const stateFile = path.join(tmpDir, "session-binds.json");
    setSessionBindStateFileForTest(stateFile);

    bindFridayDeviceToSession(sessionKey, watcherDevice);
    expect(watchedDevicesForSessionKey(sessionKey)).toEqual([watcherDevice]);

    // Simulate gateway restart: wipe in-memory state, keep the file.
    resetSessionBindingsForTest();

    expect(watchedDevicesForSessionKey(sessionKey)).toEqual([watcherDevice]);
    // The restored bind must route a live frame to the device again.
    (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mockClear();
    delta(2, "after restart");
    expect(sseEmitter.broadcastToRun).toHaveBeenCalledTimes(1);
  });

  it("normalizes bare and legacy session keys for the watched registry", () => {
    bindFridayDeviceToSession("main", watcherDevice);
    expect(watchedDevicesForSessionKey("agent:main:main")).toEqual([watcherDevice]);
    bindFridayDeviceToSession(sessionKey.toUpperCase(), watcherDevice);
    expect(watchedDevicesForSessionKey(sessionKey)).toEqual([watcherDevice]);
  });

  it("re-bind never re-injects frames already delivered (watermark)", () => {
    lifecycleStart();
    delta(2, "hello");
    lifecycleEnd(3);

    expect(bindFridayDeviceToSession(sessionKey, watcherDevice)).toBe(3);
    (sseEmitter.broadcast as ReturnType<typeof vi.fn>).mockClear();

    // Re-opening the session binds again — the completed run must NOT be re-delivered
    // (the app would treat the replayed lifecycle.start as a restart and unfreeze the
    // round that just landed on disk).
    expect(bindFridayDeviceToSession(sessionKey, watcherDevice)).toBe(0);
    expect(sseEmitter.broadcast).not.toHaveBeenCalled();
  });

  it("live frames update the watermark so a mid-run re-bind skips them", () => {
    bindFridayDeviceToSession(sessionKey, watcherDevice);
    (sseEmitter.broadcast as ReturnType<typeof vi.fn>).mockClear();

    // Run streams live to the bound device (owner path), then the user re-opens the
    // session: the buffer now holds the same frames, but they must not be re-injected.
    lifecycleStart();
    delta(2, "streaming");
    (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mockClear();

    expect(bindFridayDeviceToSession(sessionKey, watcherDevice)).toBe(0);
    expect(sseEmitter.broadcast).not.toHaveBeenCalled();
  });

  it("a second device still receives the full replay on first bind", () => {
    lifecycleStart();
    delta(2, "hello");
    lifecycleEnd(3);
    bindFridayDeviceToSession(sessionKey, watcherDevice);

    (sseEmitter.broadcast as ReturnType<typeof vi.fn>).mockClear();
    const otherDevice = "CCCCCCCC-DDDD-EEEE-FFFF-000000000000";
    expect(bindFridayDeviceToSession(sessionKey, otherDevice)).toBe(3);
    const calls = (sseEmitter.broadcast as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call[1]).toBe(otherDevice);
    }
  });
});