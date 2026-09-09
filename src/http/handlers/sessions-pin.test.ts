import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { handleSessionsPin } from "./sessions-pin.js";
import { setFridayNextRuntime } from "../../runtime.js";
import {
  resetFridayAgentForwardRuntimeForTest,
  setFridayAgentForwardRuntime,
} from "../../agent-forward-runtime.js";

class MockRes extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  end(body?: string): void {
    if (body) this.body += body;
  }
}

function makeReq(body: unknown, headers: Record<string, string> = {}, method = "PUT"): any {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as any;
  req.method = method;
  req.url = "/friday-next/sessions/pin";
  req.headers = headers;
  return req;
}

const AUTH = { authorization: "Bearer test-token" };
const CFG = {
  channels: { "friday-next": { authToken: "test-token", pathPrefix: "/friday-next" } },
  gateway: { auth: { token: "test-token" } },
};
const SESSION_KEY = "agent:main:friday:direct:device:1";

type WriterKind = "patch" | "legacy";

function setForward(
  entry: Record<string, unknown>,
  options: { patch?: boolean; legacy?: boolean } = { patch: true },
): { calls: WriterKind[]; current: () => Record<string, unknown> } {
  const calls: WriterKind[] = [];
  let currentEntry = { ...entry };
  const apply = async (
    kind: WriterKind,
    update: (
      entry: Record<string, unknown>,
    ) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>,
  ) => {
    calls.push(kind);
    const patch = await update({ ...currentEntry });
    if (!patch) return null;
    currentEntry = { ...currentEntry, ...patch };
    return { ...currentEntry };
  };

  setFridayAgentForwardRuntime({
    runtime: {
      agent: {
        session: {
          resolveStorePath: () => "/store/main.json",
          getSessionEntry: ({ sessionKey }: { sessionKey: string }) =>
            sessionKey.toLowerCase() === SESSION_KEY ? { ...currentEntry } : undefined,
          ...(options.patch
            ? {
                patchSessionEntry: async (params: {
                  update: (
                    entry: Record<string, unknown>,
                    context: { existingEntry?: Record<string, unknown> },
                  ) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
                }) => apply("patch", (value) => params.update(value, { existingEntry: value })),
              }
            : {}),
          ...(options.legacy
            ? {
                updateSessionStoreEntry: async (params: {
                  update: (
                    entry: Record<string, unknown>,
                  ) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
                }) => apply("legacy", params.update),
              }
            : {}),
        },
      },
      config: { current: () => CFG },
    },
  } as any);

  return { calls, current: () => currentEntry };
}

describe("handleSessionsPin", () => {
  beforeEach(() => {
    setFridayNextRuntime({ config: { loadConfig: () => CFG }, logger: {} } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetFridayAgentForwardRuntimeForTest();
  });

  it("pins a session with the server timestamp", async () => {
    vi.setSystemTime(1_800_000_000_000);
    const state = setForward({ sessionId: "s1", updatedAt: 10 });
    const res = new MockRes();

    await handleSessionsPin(makeReq({ sessionKey: SESSION_KEY, pinned: true }, AUTH), res as any);

    expect(res.statusCode).toBe(200);
    expect(state.calls).toEqual(["patch"]);
    expect(state.current()).toMatchObject({ pinned: true, pinnedAt: 1_800_000_000_000 });
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      sessionKey: SESSION_KEY,
      pinned: true,
      pinnedAt: 1_800_000_000_000,
    });
  });

  it("unpins a session and removes pinnedAt", async () => {
    const state = setForward({ sessionId: "s1", pinned: true, pinnedAt: 123 });
    const res = new MockRes();

    await handleSessionsPin(makeReq({ sessionKey: SESSION_KEY, pinned: false }, AUTH), res as any);

    expect(res.statusCode).toBe(200);
    expect(state.current()).toMatchObject({ pinned: false, pinnedAt: undefined });
    expect(JSON.parse(res.body)).toEqual({ ok: true, sessionKey: SESSION_KEY, pinned: false });
  });

  it("keeps pinnedAt unchanged when pinning an already pinned session", async () => {
    vi.setSystemTime(1_800_000_000_000);
    const state = setForward({ sessionId: "s1", pinned: true, pinnedAt: 456 });
    const res = new MockRes();

    await handleSessionsPin(makeReq({ sessionKey: SESSION_KEY, pinned: true }, AUTH), res as any);

    expect(res.statusCode).toBe(200);
    expect(state.current().pinnedAt).toBe(456);
    expect(JSON.parse(res.body).pinnedAt).toBe(456);
  });

  it("falls back to updateSessionStoreEntry when identity patch is unavailable", async () => {
    const state = setForward({ sessionId: "s1" }, { patch: false, legacy: true });
    const res = new MockRes();

    await handleSessionsPin(makeReq({ sessionKey: SESSION_KEY, pinned: true }, AUTH), res as any);

    expect(res.statusCode).toBe(200);
    expect(state.calls).toEqual(["legacy"]);
    expect(state.current()).toMatchObject({ pinned: true, pinnedAt: expect.any(Number) });
  });

  it.each([
    [{ pinned: true }, "missing sessionKey"],
    [{ sessionKey: "  ", pinned: true }, "empty sessionKey"],
    [{ sessionKey: SESSION_KEY }, "missing pinned"],
    [{ sessionKey: SESSION_KEY, pinned: "true" }, "non-boolean pinned"],
  ])("rejects invalid input: %s", async (body) => {
    setForward({ sessionId: "s1" });
    const res = new MockRes();
    await handleSessionsPin(makeReq(body, AUTH), res as any);
    expect(res.statusCode).toBe(400);
  });

  it.each([{}, { authorization: "Bearer wrong-token" }])(
    "rejects missing or invalid bearer token",
    async (headers) => {
      setForward({ sessionId: "s1" });
      const res = new MockRes();
      await handleSessionsPin(
        makeReq({ sessionKey: SESSION_KEY, pinned: true }, headers),
        res as any,
      );
      expect(res.statusCode).toBe(401);
    },
  );

  it("rejects non-PUT methods with 405", async () => {
    setForward({ sessionId: "s1" });
    const res = new MockRes();
    await handleSessionsPin(
      makeReq({ sessionKey: SESSION_KEY, pinned: true }, AUTH, "POST"),
      res as any,
    );
    expect(res.statusCode).toBe(405);
  });
});
