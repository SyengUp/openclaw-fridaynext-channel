import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleLocationQueryResult } from "./location-query-result.js";
import { setMockRuntime } from "../../test-support/mock-runtime.js";
import {
  resetLocationQueryPendingStoreForTest,
  waitForLocationQueryResult,
} from "../../location/pending-store.js";

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

describe("handleLocationQueryResult", () => {
  beforeEach(() => {
    setMockRuntime();
    resetLocationQueryPendingStoreForTest();
  });

  afterEach(() => {
    resetLocationQueryPendingStoreForTest();
  });

  it("returns 405 on non-post", async () => {
    const req = { method: "GET", headers: {} } as IncomingMessage;
    const res = new MockRes() as unknown as ServerResponse;
    await handleLocationQueryResult(req, res);
    expect((res as unknown as MockRes).statusCode).toBe(405);
  });

  it("returns 401 without bearer", async () => {
    const req = mockReq("POST");
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleLocationQueryResult(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ requestId: "r1", ok: true, payload: {} }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(401);
  });

  it("returns 404 when requestId is not pending", async () => {
    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleLocationQueryResult(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ requestId: "missing", ok: true, payload: {} }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(404);
  });

  it("resolves a pending query", async () => {
    const waiter = waitForLocationQueryResult({ requestId: "r-ok", deviceId: "DEV1" });
    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleLocationQueryResult(req as unknown as IncomingMessage, res);
    req.end(
      JSON.stringify({
        requestId: "r-ok",
        ok: true,
        payload: {
          latitude: 31.2,
          longitude: 121.5,
          horizontalAccuracy: 9,
          timestampMs: 1_700_000_000_000,
        },
      }),
    );
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(200);
    await expect(waiter).resolves.toEqual({
      ok: true,
      payload: {
        latitude: 31.2,
        longitude: 121.5,
        horizontalAccuracy: 9,
        timestampMs: 1_700_000_000_000,
      },
    });
  });
});
