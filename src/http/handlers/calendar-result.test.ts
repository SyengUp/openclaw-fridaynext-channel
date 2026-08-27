import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleCalendarResult } from "./calendar-result.js";
import { setMockRuntime } from "../../test-support/mock-runtime.js";
import {
  resetCalendarPendingStoreForTest,
  waitForCalendarResult,
} from "../../calendar/pending-store.js";

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

function mockReq(
  method: string,
  headers: Record<string, string> = {},
): PassThrough & { method: string; headers: Record<string, string> } {
  const stream = new PassThrough() as unknown as PassThrough & {
    method: string;
    headers: Record<string, string>;
  };
  stream.method = method;
  stream.headers = headers;
  return stream;
}

describe("handleCalendarResult", () => {
  beforeEach(() => {
    setMockRuntime();
    resetCalendarPendingStoreForTest();
  });

  afterEach(() => {
    resetCalendarPendingStoreForTest();
  });

  it("returns 405 on non-post", async () => {
    const req = { method: "GET", headers: {} } as IncomingMessage;
    const res = new MockRes() as unknown as ServerResponse;
    await handleCalendarResult(req, res);
    expect((res as unknown as MockRes).statusCode).toBe(405);
  });

  it("returns 401 without bearer", async () => {
    const req = mockReq("POST");
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleCalendarResult(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ requestId: "r1", ok: true, payload: {} }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(401);
  });

  it("returns 400 on missing requestId", async () => {
    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleCalendarResult(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ ok: true, payload: {} }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(400);
  });

  it("returns 404 when requestId is not pending", async () => {
    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleCalendarResult(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ requestId: "missing", ok: true, payload: {} }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(404);
  });

  it("resolves a pending query", async () => {
    const waiter = waitForCalendarResult({ requestId: "r-ok", deviceId: "DEV1" });
    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleCalendarResult(req as unknown as IncomingMessage, res);
    req.end(
      JSON.stringify({
        requestId: "r-ok",
        ok: true,
        payload: { events: [{ title: "Team sync" }], reminders: [] },
      }),
    );
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(200);
    await expect(waiter).resolves.toEqual({
      ok: true,
      payload: { events: [{ title: "Team sync" }], reminders: [] },
    });
  });

  it("normalizes a missing error code to CALENDAR_UNAVAILABLE", async () => {
    const waiter = waitForCalendarResult({ requestId: "r-err", deviceId: "DEV1" });
    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleCalendarResult(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ requestId: "r-err", ok: false }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(200);
    await expect(waiter).resolves.toEqual({
      ok: false,
      error: { code: "CALENDAR_UNAVAILABLE", message: "Calendar request failed" },
    });
  });
});
