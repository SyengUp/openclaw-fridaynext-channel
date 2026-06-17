import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setMockRuntime } from "../../test-support/mock-runtime.js";

const { mockList, mockApprove } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockApprove: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/device-bootstrap", () => ({
  listDevicePairing: mockList,
  approveDevicePairing: mockApprove,
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

const DEVICE_ID = "a80b8c4b305fb02c5772c409c6dfcbacde691b61557f7779511ad1a5be8fdf06";
const REQUEST_ID = "12f150e8-b1bc-4688-be23-e3a7fa8b9e51";

describe("handleDeviceApprove", () => {
  beforeEach(() => {
    setMockRuntime();
    vi.clearAllMocks();
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

  it("returns 502 when listDevicePairing fails", async () => {
    mockList.mockRejectedValueOnce(new Error("ENOENT"));

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleDeviceApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ deviceId: DEVICE_ID }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(502);
    expect(JSON.parse((res as unknown as MockRes).body).error).toContain("Failed to list devices");
  });

  it("returns 404 when listDevicePairing returns data without matching device", async () => {
    mockList.mockResolvedValueOnce({
      pending: [{ requestId: "x", deviceId: "UNMATCHED" }],
      paired: [],
    });

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleDeviceApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ deviceId: DEVICE_ID }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(404);
  });

  it("returns 404 when deviceId not in pending list", async () => {
    mockList.mockResolvedValueOnce({
      pending: [{ requestId: "uuid-1", deviceId: "OTHER_DEVICE" }],
      paired: [],
    });

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
    mockList.mockResolvedValueOnce({ pending: [], paired: [] });

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleDeviceApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ deviceId: DEVICE_ID }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(404);
  });

  it("returns 502 when approveDevicePairing fails", async () => {
    mockList.mockResolvedValueOnce({
      pending: [{ requestId: REQUEST_ID, deviceId: DEVICE_ID }],
      paired: [],
    });
    mockApprove.mockRejectedValueOnce(new Error("unknown requestId"));

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleDeviceApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ deviceId: DEVICE_ID }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(502);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.error).toContain("Device approval failed");
    expect(body.detail).toBe("unknown requestId");
  });

  it("returns 404 when approveDevicePairing returns null", async () => {
    mockList.mockResolvedValueOnce({
      pending: [{ requestId: REQUEST_ID, deviceId: DEVICE_ID }],
      paired: [],
    });
    mockApprove.mockResolvedValueOnce(null);

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleDeviceApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ deviceId: DEVICE_ID }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(404);
    expect(JSON.parse((res as unknown as MockRes).body).error).toContain("not found");
  });

  it("succeeds with complete flow", async () => {
    mockList.mockResolvedValueOnce({
      pending: [{ requestId: REQUEST_ID, deviceId: DEVICE_ID }],
      paired: [],
    });
    mockApprove.mockResolvedValueOnce({
      status: "approved",
      requestId: REQUEST_ID,
      device: { deviceId: DEVICE_ID, approvedAtMs: 1778571972361 },
    });

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
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockApprove).toHaveBeenCalledTimes(1);
  });

  it("normalizes deviceId case-insensitively", async () => {
    mockList.mockResolvedValueOnce({
      pending: [{ requestId: REQUEST_ID, deviceId: DEVICE_ID }],
      paired: [],
    });
    mockApprove.mockResolvedValueOnce({
      status: "approved",
      requestId: REQUEST_ID,
      device: { deviceId: DEVICE_ID, approvedAtMs: 1 },
    });

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
