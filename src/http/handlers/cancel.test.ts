import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleCancel } from "./cancel.js";
import { sseEmitter } from "../../sse/emitter.js";
import { setMockRuntime } from "../../test-support/mock-runtime.js";
import { resetMockDispatch } from "../../test-support/mock-dispatch.js";

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

function mockReq(method: string, headers: Record<string, string> = {}): PassThrough & { method: string; headers: Record<string, string> } {
  const stream = new PassThrough() as unknown as PassThrough & { method: string; headers: Record<string, string> };
  stream.method = method;
  stream.headers = headers;
  return stream;
}

describe("handleCancel", () => {
  beforeEach(() => {
    setMockRuntime();
  });

  it("returns 405 on non-post", async () => {
    const req = { method: "GET", headers: {} } as IncomingMessage;
    const res = new MockRes() as unknown as ServerResponse;
    await handleCancel(req, res);
    expect((res as unknown as MockRes).statusCode).toBe(405);
  });

  it("returns 401 for missing auth", async () => {
    const req = mockReq("POST");
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleCancel(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ runId: "run-1" }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(401);
  });

  it("returns 400 for missing runId", async () => {
    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleCancel(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({}));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(400);
  });

  it("untracks run under Vitest (abort skipped)", async () => {
    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const spyUntrack = vi.spyOn(sseEmitter, "untrackRun").mockImplementation(() => {});
    const p = handleCancel(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ runId: "run-1" }));
    await p;
    expect(spyUntrack).toHaveBeenCalledWith("run-1");
    expect((res as unknown as MockRes).statusCode).toBe(200);
    spyUntrack.mockRestore();
  });
});
