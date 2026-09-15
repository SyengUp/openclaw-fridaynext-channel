import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sseEmitter } from "../sse/emitter.js";
import {
  deviceIdFromTalkConnId,
  emitSdkTalkEvent,
  forwardTalkEvents,
  installTalkEventBridge,
  mintTalkOwnerConnId,
  rememberTalkSession,
  resetTalkSessionBridgeForTest,
} from "./talk-session-bridge.js";

class MockRes extends EventEmitter {
  writes: string[] = [];
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
  end(): void {}
}

describe("talk-session-bridge", () => {
  afterEach(() => {
    resetTalkSessionBridgeForTest();
    sseEmitter.resetForTest();
  });

  it("encodes and recovers the device id from the synthetic connId", () => {
    const connId = mintTalkOwnerConnId("phone-1");
    expect(connId.startsWith("friday-talk:PHONE-1:")).toBe(true);
    expect(deviceIdFromTalkConnId(connId)).toBe("PHONE-1");
    expect(deviceIdFromTalkConnId("other")).toBeUndefined();
  });

  it("forwards talk.event audio live and transcript durably", () => {
    const res = new MockRes();
    sseEmitter.addConnection("PHONE-1", res as never);
    const connId = mintTalkOwnerConnId("phone-1");
    rememberTalkSession("sess-1", { kind: "dispatch", deviceId: "PHONE-1", connId });

    forwardTalkEvents({ type: "audio", audioBase64: "YWI=", relaySessionId: "sess-1" }, [connId]);
    forwardTalkEvents(
      { type: "transcript", role: "user", text: "hi", final: true, relaySessionId: "sess-1" },
      [connId],
    );

    const body = res.writes.join("");
    expect(body).toContain("event: talk");
    expect(body).toContain("YWI=");
    expect(body).toContain("hi");
    expect(body).not.toMatch(/id: \d+\nevent: talk[\s\S]*YWI=/);
  });

  it("preserves the OpenClaw realtime transcript shape for iOS", () => {
    const res = new MockRes();
    sseEmitter.addConnection("PHONE-4", res as never);
    const connId = mintTalkOwnerConnId("phone-4");
    rememberTalkSession("sess-live", {
      kind: "dispatch",
      deviceId: "PHONE-4",
      connId,
    });

    forwardTalkEvents(
      {
        type: "transcript",
        role: "assistant",
        text: "听见了，主人。很清楚。",
        final: true,
        relaySessionId: "sess-live",
      },
      new Set([connId]),
    );

    const body = res.writes.join("");
    expect(body).toContain("event: talk");
    expect(body).toContain('"sessionId":"sess-live"');
    expect(body).toContain('"relaySessionId":"sess-live"');
    expect(body).toContain('"role":"assistant"');
    expect(body).toContain('"final":true');
    expect(body).toContain("听见了，主人。很清楚。");
  });

  it("installTalkEventBridge intercepts talk.event and still calls the original", () => {
    const original = vi.fn();
    const context = { broadcastToConnIds: original };
    installTalkEventBridge(context);
    const connId = mintTalkOwnerConnId("phone-2");
    rememberTalkSession("sess-2", { kind: "dispatch", deviceId: "PHONE-2", connId });
    context.broadcastToConnIds(
      "talk.event",
      { type: "ready", relaySessionId: "sess-2" },
      new Set([connId]),
    );
    expect(original).toHaveBeenCalledTimes(1);
    context.broadcastToConnIds("agent", { text: "x" }, new Set(["other"]));
    expect(original).toHaveBeenCalledTimes(2);
  });

  it("normalizes SDK pcm buffers into audioBase64", () => {
    const res = new MockRes();
    sseEmitter.addConnection("PHONE-3", res as never);
    emitSdkTalkEvent("PHONE-3", { type: "audio", pcm: Buffer.from("ab") });
    expect(res.writes.join("")).toContain(Buffer.from("ab").toString("base64"));
    expect(res.writes.join("")).not.toContain("pcm");
  });
});
