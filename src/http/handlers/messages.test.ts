import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMessages } from "./messages.js";
import { clearFridayNextRuntime, setFridayNextRuntime } from "../../runtime.js";
import {
  __resetMockFridayDispatchForTests,
  __setMockFridayDispatchForTests,
} from "../../agent/dispatch-bridge.js";
import { sseEmitter } from "../../sse/emitter.js";

class MockRes extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  end(body?: string): void {
    if (body) this.body += body;
    this.emit("finish");
  }
}

describe("handleMessages dispatch context (owner fields)", () => {
  afterEach(() => {
    clearFridayNextRuntime();
    __resetMockFridayDispatchForTests();
  });

  it("passes SenderId and OwnerAllowFrom as normalized device id to runFridayDispatch", async () => {
    setFridayNextRuntime({
      config: { loadConfig: () => ({ gateway: { auth: { token: "tok" } }, channels: {} }) },
    } as never);

    let capturedCtx: Record<string, unknown> | null = null;
    const dispatchCalled = new Promise<void>((resolve) => {
      __setMockFridayDispatchForTests((args: unknown) => {
        const a = args as { ctx?: Record<string, unknown> };
        capturedCtx = a.ctx ?? null;
        resolve();
        return Promise.resolve();
      });
    });

    const req = new PassThrough() as unknown as IncomingMessage;
    req.method = "POST";
    req.headers = { authorization: "Bearer tok" };

    const res = new MockRes() as unknown as ServerResponse;
    const p = handleMessages(req, res);

    req.end(
      JSON.stringify({
        deviceId: "aa11bb22-cc33-dd44-ee55-ff6677889900",
        text: "hello",
        sessionKey: "default",
      }),
    );

    await p;
    await dispatchCalled;

    expect((res as unknown as MockRes).statusCode).toBe(202);
    expect(capturedCtx).not.toBeNull();
    const want = "AA11BB22-CC33-DD44-EE55-FF6677889900";
    expect(capturedCtx!.SenderId).toBe(want);
    expect(capturedCtx!.OwnerAllowFrom).toEqual([want]);
    expect(capturedCtx!.From).toBe(want);
  });

  it("adds fridayNext mediaKind metadata for audio deliver payload", async () => {
    setFridayNextRuntime({
      config: { loadConfig: () => ({ gateway: { auth: { token: "tok" } }, channels: {} }) },
    } as never);

    const dispatchCalled = new Promise<void>((resolve) => {
      __setMockFridayDispatchForTests(async (args: unknown) => {
        const a = args as {
          dispatcherOptions?: { deliver?: (payload: unknown, info: { kind: string }) => Promise<void> };
        };
        if (a.dispatcherOptions?.deliver) {
          await a.dispatcherOptions.deliver(
            { mediaUrl: "/tmp/tts-run/voice-1.mp3", audioAsVoice: false },
            { kind: "block" },
          );
        }
        resolve();
      });
    });

    const req = new PassThrough() as unknown as IncomingMessage;
    req.method = "POST";
    req.headers = { authorization: "Bearer tok" };
    const res = new MockRes() as unknown as ServerResponse;
    let observedPayload: Record<string, unknown> | null = null;
    const broadcastSpy = vi.spyOn(sseEmitter, "broadcastToRun").mockImplementation((_: string, evt: unknown) => {
      const data = (evt as { data?: { payload?: Record<string, unknown> } })?.data;
      if (data?.payload) observedPayload = data.payload;
    });

    const p = handleMessages(req, res);
    req.end(
      JSON.stringify({
        deviceId: "AA11",
        text: "hello",
        sessionKey: "default",
      }),
    );
    await p;
    await dispatchCalled;
    broadcastSpy.mockRestore();

    expect(observedPayload).not.toBeNull();
    const channelData = observedPayload!.channelData as { fridayNext?: { mediaKind?: string } };
    expect(channelData?.fridayNext?.mediaKind).toBe("tts_likely");
  });
});
