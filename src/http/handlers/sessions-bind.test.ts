import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleSessionsBind } from "./sessions-bind.js";
import { clearFridayNextRuntime, setFridayNextRuntime } from "../../runtime.js";
import { resetSessionBindingsForTest, watchedDevicesForSessionKey } from "../../friday-session.js";
import { sseEmitter } from "../../sse/emitter.js";
import { sessionReplayBuffer } from "../../sse/session-replay-buffer.js";

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

const sessionKey = "agent:main:control-ui-session";
const deviceId = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

async function post(body: unknown, auth: string | null): Promise<MockRes> {
  const req = new PassThrough() as unknown as IncomingMessage;
  req.method = "POST";
  req.headers = auth ? { authorization: `Bearer ${auth}` } : {};
  const res = new MockRes() as unknown as ServerResponse;
  const p = handleSessionsBind(req, res);
  req.end(JSON.stringify(body));
  await p;
  return res as unknown as MockRes;
}

describe("handleSessionsBind", () => {
  beforeEach(() => {
    sseEmitter.resetForTest();
    sessionReplayBuffer.resetForTest();
    resetSessionBindingsForTest();
    setFridayNextRuntime({
      config: { loadConfig: () => ({ gateway: { auth: { token: "tok" } }, channels: {} }) },
    } as never);
  });

  afterEach(() => {
    clearFridayNextRuntime();
  });

  it("binds the device and registers the watched session", async () => {
    const res = await post({ deviceId, sessionKey }, "tok");
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body) as { ok: boolean; replayed: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.replayed).toBe(0);
    expect(watchedDevicesForSessionKey(sessionKey)).toEqual([deviceId]);
  });

  it("replays buffered frames for an already-active session", async () => {
    // Prime the replay buffer exactly like an un-owned Control UI run would.
    sessionReplayBuffer.append(sessionKey, {
      type: "agent",
      data: { runId: "r1", seq: 1, stream: "assistant", data: { text: "hi" }, sessionKey },
    });
    const res = await post({ deviceId, sessionKey }, "tok");
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { replayed: number }).replayed).toBe(1);
  });

  it("rejects missing fields with 400", async () => {
    expect((await post({ deviceId }, "tok")).statusCode).toBe(400);
    expect((await post({ sessionKey }, "tok")).statusCode).toBe(400);
  });

  it("rejects requests without a valid bearer token", async () => {
    expect((await post({ deviceId, sessionKey }, null)).statusCode).toBe(401);
    expect((await post({ deviceId, sessionKey }, "wrong")).statusCode).toBe(401);
  });

  it("rejects non-POST methods", async () => {
    const req = new PassThrough() as unknown as IncomingMessage;
    req.method = "GET";
    req.headers = { authorization: "Bearer tok" };
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleSessionsBind(req, res);
    req.end();
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(405);
  });
});