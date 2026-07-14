import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMessages, composeBodyWithMediaRefs } from "./messages.js";
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

describe("composeBodyWithMediaRefs", () => {
  it("returns trimmed text alone when no media refs", () => {
    expect(composeBodyWithMediaRefs("  hi  ", [])).toBe("hi");
  });

  it("joins text and media refs with a blank line", () => {
    expect(composeBodyWithMediaRefs("hi", ["[media attached: file:///a]"])).toBe(
      "hi\n\n[media attached: file:///a]",
    );
  });

  it("omits the leading blank line when text is empty (attachment-only)", () => {
    expect(
      composeBodyWithMediaRefs("", ["[media attached: file:///a]", "[media attached: file:///b]"]),
    ).toBe("[media attached: file:///a]\n[media attached: file:///b]");
  });
});

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

  it("accepts attachment-only messages (empty text + attachments) and dispatches", async () => {
    setFridayNextRuntime({
      config: { loadConfig: () => ({ gateway: { auth: { token: "tok" } }, channels: {} }) },
    } as never);

    let dispatched = false;
    const dispatchCalled = new Promise<void>((resolve) => {
      __setMockFridayDispatchForTests(() => {
        dispatched = true;
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
        deviceId: "AA11",
        text: "",
        attachments: ["att-1"],
        sessionKey: "default",
      }),
    );

    await p;
    await dispatchCalled;

    expect((res as unknown as MockRes).statusCode).toBe(202);
    expect(dispatched).toBe(true);
  });

  it("rejects messages with neither text nor attachments", async () => {
    setFridayNextRuntime({
      config: { loadConfig: () => ({ gateway: { auth: { token: "tok" } }, channels: {} }) },
    } as never);

    const req = new PassThrough() as unknown as IncomingMessage;
    req.method = "POST";
    req.headers = { authorization: "Bearer tok" };
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleMessages(req, res);

    req.end(
      JSON.stringify({ deviceId: "AA11", text: "   ", attachments: [], sessionKey: "default" }),
    );

    await p;

    expect((res as unknown as MockRes).statusCode).toBe(400);
  });

  it("adds fridayNext mediaKind metadata for audio deliver payload", async () => {
    setFridayNextRuntime({
      config: { loadConfig: () => ({ gateway: { auth: { token: "tok" } }, channels: {} }) },
    } as never);

    const dispatchCalled = new Promise<void>((resolve) => {
      __setMockFridayDispatchForTests(async (args: unknown) => {
        const a = args as {
          dispatcherOptions?: {
            deliver?: (payload: unknown, info: { kind: string }) => Promise<void>;
          };
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
    const broadcastSpy = vi
      .spyOn(sseEmitter, "broadcastToRun")
      .mockImplementation((_: string, evt: unknown) => {
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

describe("handleMessages dispatch error path", () => {
  afterEach(() => {
    clearFridayNextRuntime();
    __resetMockFridayDispatchForTests();
    vi.restoreAllMocks();
  });

  function setRuntime(): void {
    setFridayNextRuntime({
      config: { loadConfig: () => ({ gateway: { auth: { token: "tok" } }, channels: {} }) },
    } as never);
  }

  async function postMessage(): Promise<void> {
    const req = new PassThrough() as unknown as IncomingMessage;
    req.method = "POST";
    req.headers = { authorization: "Bearer tok" };
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleMessages(req, res);
    req.end(JSON.stringify({ deviceId: "AA11", text: "hello", sessionKey: "default" }));
    await p;
  }

  function collectDispatchErrors(): { errors: string[] } {
    const out: { errors: string[] } = { errors: [] };
    vi.spyOn(sseEmitter, "broadcastToRun").mockImplementation((_: string, evt: unknown) => {
      const data = (evt as { type?: string; data?: { op?: string; error?: string } })?.data;
      if (data?.op === "dispatch_error") out.errors.push(String(data.error));
    });
    return out;
  }

  it("broadcasts a dispatch_error once when the dispatch rejects", async () => {
    setRuntime();
    const broadcasts = collectDispatchErrors();
    let calls = 0;
    __setMockFridayDispatchForTests(() => {
      calls += 1;
      return Promise.reject(new Error("boom"));
    });

    await postMessage();
    await vi.waitFor(() => {
      expect(broadcasts.errors.length).toBe(1);
    });

    expect(calls).toBe(1);
    expect(broadcasts.errors[0]).toContain("boom");
  });
});
