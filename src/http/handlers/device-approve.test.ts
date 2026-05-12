import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setMockRuntime } from "../../test-support/mock-runtime.js";

const mockExecImpl = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  exec: mockExecImpl,
}));

import { handleDeviceApprove } from "./device-approve.js";

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

function mockExecSuccess(stdout: string) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  mockExecImpl.mockImplementationOnce((_cmd: string, _opts: unknown, cb: (error: null, stdout: string, stderr: string) => void) => {
    cb(null, stdout, "");
    return child;
  });
}

function mockExecError(message: string, stderr?: string) {
  const err = new Error(message) as Error & { stderr: string };
  err.stderr = stderr ?? "";
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  mockExecImpl.mockImplementationOnce((_cmd: string, _opts: unknown, cb: (error: Error) => void) => {
    cb(err);
    return child;
  });
}

function mockExecErrorWithStderr(err: Error & { stderr?: string }) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  mockExecImpl.mockImplementationOnce((_cmd: string, _opts: unknown, cb: (error: Error) => void) => {
    cb(err);
    return child;
  });
}

const DEVICE_ID = "a80b8c4b305fb02c5772c409c6dfcbacde691b61557f7779511ad1a5be8fdf06";
const REQUEST_ID = "12f150e8-b1bc-4688-be23-e3a7fa8b9e51";

describe("handleDeviceApprove", () => {
  beforeEach(() => {
    setMockRuntime();
    mockExecImpl.mockReset();
  });

  it("returns 405 on non-POST", async () => {
    const req = { method: "GET", headers: {} } as IncomingMessage;
    const res = new MockRes() as unknown as ServerResponse;
    await handleDeviceApprove(req, res);
    expect((res as unknown as MockRes).statusCode).toBe(405);
  });

  it("returns 401 for missing auth", async () => {
    const req = mockReq("POST");
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleDeviceApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ deviceId: DEVICE_ID }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(401);
  });

  it("returns 400 for missing body", async () => {
    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleDeviceApprove(req as unknown as IncomingMessage, res);
    req.end("");
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(400);
  });

  it("returns 400 for missing deviceId", async () => {
    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleDeviceApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({}));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(400);
    expect(JSON.parse((res as unknown as MockRes).body).error).toContain("deviceId");
  });

  it("returns 502 when devices list CLI fails", async () => {
    mockExecError("ENOENT");

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleDeviceApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ deviceId: DEVICE_ID }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(502);
    expect(JSON.parse((res as unknown as MockRes).body).error).toContain("Failed to list devices");
  });

  it("returns 502 when devices list returns invalid JSON", async () => {
    mockExecSuccess("not valid json {{{");

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleDeviceApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ deviceId: DEVICE_ID }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(502);
    expect(JSON.parse((res as unknown as MockRes).body).error).toContain("Unexpected response");
  });

  it("returns 404 when deviceId not in pending list", async () => {
    mockExecSuccess(JSON.stringify({
      pending: [{ requestId: "uuid-1", deviceId: "OTHER_DEVICE" }],
      paired: [],
    }));

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleDeviceApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ deviceId: DEVICE_ID }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(404);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.error).toContain("No pending device found");
    expect(body.deviceId).toBe(DEVICE_ID.toUpperCase());
  });

  it("returns 404 when pending array is empty", async () => {
    mockExecSuccess(JSON.stringify({ pending: [], paired: [] }));

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleDeviceApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ deviceId: DEVICE_ID }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(404);
  });

  it("returns 502 when approve command fails", async () => {
    mockExecSuccess(JSON.stringify({
      pending: [{ requestId: REQUEST_ID, deviceId: DEVICE_ID }],
      paired: [],
    }));
    // second call (approve) fails
    const approveErr = new Error("Command failed") as Error & { stderr: string };
    approveErr.stderr = "unknown requestId";
    mockExecErrorWithStderr(approveErr);

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleDeviceApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ deviceId: DEVICE_ID }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(502);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.error).toContain("Device approval command failed");
    expect(body.detail).toBe("unknown requestId");
  });

  it("returns 502 when approve returns non-JSON", async () => {
    mockExecSuccess(JSON.stringify({
      pending: [{ requestId: REQUEST_ID, deviceId: DEVICE_ID }],
      paired: [],
    }));
    mockExecSuccess("No pending device pairing requests to approve");

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleDeviceApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ deviceId: DEVICE_ID }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(502);
    expect(JSON.parse((res as unknown as MockRes).body).error).toContain("Unexpected response from device approval");
  });

  it("succeeds with complete flow", async () => {
    mockExecSuccess(JSON.stringify({
      pending: [{ requestId: REQUEST_ID, deviceId: DEVICE_ID }],
      paired: [],
    }));
    mockExecSuccess(JSON.stringify({
      requestId: REQUEST_ID,
      device: { deviceId: DEVICE_ID, approvedAtMs: 1778571972361 },
    }));

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleDeviceApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ deviceId: DEVICE_ID }));
    await p;

    expect((res as unknown as MockRes).statusCode).toBe(200);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.ok).toBe(true);
    expect(body.deviceId).toBe(DEVICE_ID.toUpperCase());
    expect(body.requestId).toBe(REQUEST_ID);
    expect(body.approvedAtMs).toBe(1778571972361);
    expect(mockExecImpl).toHaveBeenCalledTimes(2);
  });

  it("normalizes deviceId case-insensitively", async () => {
    mockExecSuccess(JSON.stringify({
      pending: [{ requestId: REQUEST_ID, deviceId: DEVICE_ID }],
      paired: [],
    }));
    mockExecSuccess(JSON.stringify({
      requestId: REQUEST_ID,
      device: { deviceId: DEVICE_ID, approvedAtMs: 1 },
    }));

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleDeviceApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ deviceId: DEVICE_ID.toLowerCase() }));
    await p;

    expect((res as unknown as MockRes).statusCode).toBe(200);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.ok).toBe(true);
    expect(body.deviceId).toBe(DEVICE_ID.toUpperCase());
  });
});
