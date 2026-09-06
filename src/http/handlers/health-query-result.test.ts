import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleHealthQueryResult } from "./health-query-result.js";
import { setMockRuntime } from "../../test-support/mock-runtime.js";
import {
  resetHealthQueryPendingStoreForTest,
  waitForHealthQueryResult,
} from "../../health-query/pending-store.js";
import { getRuntimeV3Store } from "../../runtime-v3/runtime-store.js";

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

describe("handleHealthQueryResult", () => {
  beforeEach(() => {
    setMockRuntime();
    resetHealthQueryPendingStoreForTest();
  });

  afterEach(() => {
    resetHealthQueryPendingStoreForTest();
  });

  it("returns 405 on non-post", async () => {
    const req = { method: "GET", headers: {} } as IncomingMessage;
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealthQueryResult(req, res);
    expect((res as unknown as MockRes).statusCode).toBe(405);
  });

  it("returns 401 without bearer", async () => {
    const req = mockReq("POST");
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleHealthQueryResult(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ requestId: "r1", ok: true, payload: {} }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(401);
  });

  it("returns 404 when requestId is not pending", async () => {
    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleHealthQueryResult(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ requestId: "missing", ok: true, payload: {} }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(404);
  });

  it("resolves a pending query", async () => {
    const waiter = waitForHealthQueryResult({ requestId: "r-ok", deviceId: "DEV1" });
    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleHealthQueryResult(req as unknown as IncomingMessage, res);
    req.end(
      JSON.stringify({
        requestId: "r-ok",
        ok: true,
        payload: { metrics: { steps: { total: 12 } } },
      }),
    );
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(200);
    await expect(waiter).resolves.toEqual({
      ok: true,
      payload: { metrics: { steps: { total: 12 } } },
    });
  });

  it("accepts an identical replay after the pending waiter was already resolved", async () => {
    const body = {
      requestId: "r-replay",
      ok: true,
      payload: { metrics: { steps: { total: 12 } } },
    };
    const waiter = waitForHealthQueryResult({ requestId: body.requestId, deviceId: "DEV1" });

    for (const expectedStatus of [200, 200]) {
      const req = mockReq("POST", { authorization: "Bearer test-token" });
      const res = new MockRes() as unknown as ServerResponse;
      const pending = handleHealthQueryResult(req as unknown as IncomingMessage, res);
      req.end(JSON.stringify(body));
      await pending;
      expect((res as unknown as MockRes).statusCode).toBe(expectedStatus);
    }

    await expect(waiter).resolves.toEqual({
      ok: true,
      payload: { metrics: { steps: { total: 12 } } },
    });
  });

  it("rejects a replay that changes the result payload", async () => {
    const waiter = waitForHealthQueryResult({ requestId: "r-conflict", deviceId: "DEV1" });
    const first = mockReq("POST", { authorization: "Bearer test-token" });
    const firstRes = new MockRes() as unknown as ServerResponse;
    const firstPending = handleHealthQueryResult(first as unknown as IncomingMessage, firstRes);
    first.end(JSON.stringify({ requestId: "r-conflict", ok: true, payload: { value: 1 } }));
    await firstPending;
    await waiter;

    const replay = mockReq("POST", { authorization: "Bearer test-token" });
    const replayRes = new MockRes() as unknown as ServerResponse;
    const replayPending = handleHealthQueryResult(replay as unknown as IncomingMessage, replayRes);
    replay.end(JSON.stringify({ requestId: "r-conflict", ok: true, payload: { value: 2 } }));
    await replayPending;

    expect((replayRes as unknown as MockRes).statusCode).toBe(409);
  });

  it("durably accepts a late result after the in-memory waiter was lost", async () => {
    const store = getRuntimeV3Store();
    const run = store.acceptCommand({
      clientRequestId: "request-after-restart",
      deviceId: "DEV1",
      sessionKey: "agent:main:s1",
      agentId: "main",
      text: "health",
      attachments: [],
    }).run!;
    store.appendRunEvent(run.runId, "run.started", {});
    store.appendRunEvent(run.runId, "device.health.request", {
      requestId: "r-after-restart",
    });
    store.registerDeviceRequest({
      kind: "health",
      requestId: "r-after-restart",
      deviceId: "DEV1",
      sessionKey: "agent:main:s1",
      runId: run.runId,
      sourceEventType: "fridaynext-health-query",
      payload: { metrics: ["steps"] },
    });
    resetHealthQueryPendingStoreForTest();

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const pending = handleHealthQueryResult(req as unknown as IncomingMessage, res);
    req.end(
      JSON.stringify({
        requestId: "r-after-restart",
        ok: true,
        payload: { metrics: { steps: { total: 12 } } },
      }),
    );
    await pending;

    expect((res as unknown as MockRes).statusCode).toBe(200);
    expect(store.pendingDeviceRequests("DEV1")).toEqual([]);
    expect(store.run(run.runId)?.phase).toBe("running");
    expect(store.eventsAfter("DEV1", 0).at(-1)).toMatchObject({
      sessionKey: "agent:main:s1",
      runId: run.runId,
      eventType: "device.health.result",
      payload: { requestId: "r-after-restart", ok: true },
    });
  });
});
