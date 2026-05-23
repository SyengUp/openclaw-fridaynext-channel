import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setMockRuntime } from "../../test-support/mock-runtime.js";
import { __setMockNodePairingForTests } from "../../agent/node-pairing-bridge.js";

const { mockListDevices, mockApproveDevice } = vi.hoisted(() => ({
  mockListDevices: vi.fn(),
  mockApproveDevice: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/device-bootstrap", () => ({
  listDevicePairing: mockListDevices,
  approveDevicePairing: mockApproveDevice,
}));

const { mockListNodePairing, mockApproveNodePairing } = vi.hoisted(() => ({
  mockListNodePairing: vi.fn(),
  mockApproveNodePairing: vi.fn(),
}));

import { handleHealth } from "./health.js";

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

function mockReq(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method, url, headers } as IncomingMessage;
}

const DEVICE_ID = "a80b8c4b305fb02c5772c409c6dfcbacde691b61557f7779511ad1a5be8fdf06";
const NODE_ID = "b91c9d5c416gc13d6883d510d7egcdbdf702c72668g8888622be2b6cf9eg17";
const REQUEST_ID = "12f150e8-b1bc-4688-be23-e3a7fa8b9e51";

describe("handleHealth", () => {
  beforeEach(() => {
    setMockRuntime();
    vi.clearAllMocks();
    mockListDevices.mockResolvedValue({ pending: [], paired: [] });
    mockApproveDevice.mockResolvedValue({ status: "approved", requestId: REQUEST_ID });
    __setMockNodePairingForTests({
      listNodePairing: mockListNodePairing,
      approveNodePairing: mockApproveNodePairing,
    });
    mockListNodePairing.mockResolvedValue({ pending: [], paired: [] });
    mockApproveNodePairing.mockResolvedValue({ requestId: REQUEST_ID, node: { nodeId: NODE_ID } });
  });

  // --- Method & Auth ---

  it("returns 405 on non-GET", async () => {
    const req = mockReq("POST", "/friday-next/health");
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    expect((res as unknown as MockRes).statusCode).toBe(405);
  });

  it("returns 401 for missing auth", async () => {
    const req = mockReq("GET", "/friday-next/health");
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    expect((res as unknown as MockRes).statusCode).toBe(401);
  });

  // --- Basic health (no IDs) ---

  it("returns 200 with ok:true when no IDs provided", async () => {
    const req = mockReq("GET", "/friday-next/health", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    expect((res as unknown as MockRes).statusCode).toBe(200);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.ok).toBe(true);
    expect(body.deviceId).toBe("");
    expect(body.nodeDeviceId).toBe("");
    expect(body.repairActions).toBeUndefined();
  });

  // --- selfHeal parameter ---

  it("selfHeal defaults to false (opt-in)", async () => {
    mockListDevices.mockResolvedValueOnce({
      pending: [{ requestId: REQUEST_ID, deviceId: DEVICE_ID }],
      paired: [],
    });

    const req = mockReq("GET", `/friday-next/health?deviceId=${DEVICE_ID}`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    expect((res as unknown as MockRes).statusCode).toBe(200);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.devicePairing.status).toBe("pending");
    expect(mockApproveDevice).not.toHaveBeenCalled();
  });

  it("selfHeal=true enables auto-approve", async () => {
    mockListDevices.mockResolvedValueOnce({
      pending: [{ requestId: REQUEST_ID, deviceId: DEVICE_ID }],
      paired: [],
    });

    const req = mockReq("GET", `/friday-next/health?deviceId=${DEVICE_ID}&selfHeal=true`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.devicePairing.status).toBe("ok");
    expect(body.repairActions).toHaveLength(1);
    expect(body.repairActions[0].component).toBe("devicePairing");
    expect(body.repairActions[0].result).toBe("ok");
  });

  it("selfHeal=True (capital T) is case-insensitive and enables auto-heal", async () => {
    mockListDevices.mockResolvedValueOnce({
      pending: [{ requestId: REQUEST_ID, deviceId: DEVICE_ID }],
      paired: [],
    });

    const req = mockReq("GET", `/friday-next/health?deviceId=${DEVICE_ID}&selfHeal=True`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.devicePairing.status).toBe("ok");
  });

  it("selfHeal=FALSE is case-insensitive and stays disabled", async () => {
    mockListDevices.mockResolvedValueOnce({
      pending: [{ requestId: REQUEST_ID, deviceId: DEVICE_ID }],
      paired: [],
    });

    const req = mockReq("GET", `/friday-next/health?deviceId=${DEVICE_ID}&selfHeal=FALSE`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.devicePairing.status).toBe("pending");
    expect(mockApproveDevice).not.toHaveBeenCalled();
  });

  // --- Device pairing: paired + healthy ---

  it("returns ok when device is paired and healthy", async () => {
    mockListDevices.mockResolvedValueOnce({
      pending: [],
      paired: [
        { deviceId: DEVICE_ID, approvedScopes: ["operator.read"], tokens: { t1: {} } },
      ],
    });

    const req = mockReq("GET", `/friday-next/health?deviceId=${DEVICE_ID}`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.ok).toBe(true);
    expect(body.devicePairing.status).toBe("ok");
    expect(body.devicePairing.devicePaired).toBe(true);
  });

  // --- Device pairing: degraded ---

  it("returns degraded when device has no approved scopes", async () => {
    mockListDevices.mockResolvedValueOnce({
      pending: [],
      paired: [
        { deviceId: DEVICE_ID, approvedScopes: [], tokens: { t1: {} } },
      ],
    });

    const req = mockReq("GET", `/friday-next/health?deviceId=${DEVICE_ID}`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.ok).toBe(false);
    expect(body.devicePairing.status).toBe("degraded");
    expect(body.devicePairing.approvedScopesEmpty).toBe(true);
  });

  it("returns degraded when all tokens are revoked", async () => {
    mockListDevices.mockResolvedValueOnce({
      pending: [],
      paired: [
        {
          deviceId: DEVICE_ID,
          approvedScopes: ["operator.read"],
          tokens: { t1: { revokedAtMs: 1000 } },
        },
      ],
    });

    const req = mockReq("GET", `/friday-next/health?deviceId=${DEVICE_ID}`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.ok).toBe(false);
    expect(body.devicePairing.status).toBe("degraded");
    expect(body.devicePairing.tokensRevoked).toBe(true);
  });

  // --- Device pairing: pending ---

  it("returns pending when device is pending and selfHeal is false", async () => {
    mockListDevices.mockResolvedValueOnce({
      pending: [{ requestId: REQUEST_ID, deviceId: DEVICE_ID }],
      paired: [],
    });

    const req = mockReq("GET", `/friday-next/health?deviceId=${DEVICE_ID}&selfHeal=false`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.devicePairing.status).toBe("pending");
    expect(mockApproveDevice).not.toHaveBeenCalled();
  });

  // --- Device pairing: not_found ---

  it("returns not_found when device is not in paired or pending", async () => {
    mockListDevices.mockResolvedValueOnce({ pending: [], paired: [] });

    const req = mockReq("GET", `/friday-next/health?deviceId=${DEVICE_ID}`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.ok).toBe(false);
    expect(body.devicePairing.status).toBe("not_found");
  });

  // --- Device pairing: listDevicePairing throws ---

  it("returns failed when listDevicePairing throws", async () => {
    mockListDevices.mockRejectedValueOnce(new Error("ENOENT"));

    const req = mockReq("GET", `/friday-next/health?deviceId=${DEVICE_ID}`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.devicePairing.status).toBe("failed");
    expect(body.devicePairing.detail).toContain("ENOENT");
  });

  // --- Device pairing: approveDevicePairing throws during self-heal ---

  it("returns degraded when auto-approve device throws", async () => {
    mockListDevices.mockResolvedValueOnce({
      pending: [{ requestId: REQUEST_ID, deviceId: DEVICE_ID }],
      paired: [],
    });
    mockApproveDevice.mockRejectedValueOnce(new Error("unknown requestId"));

    const req = mockReq("GET", `/friday-next/health?deviceId=${DEVICE_ID}&selfHeal=true`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.devicePairing.status).toBe("degraded");
    expect(body.repairActions).toHaveLength(1);
    expect(body.repairActions[0].result).toBe("failed");
  });

  // --- Device pairing: normalize case-insensitively ---

  it("matches deviceId case-insensitively", async () => {
    mockListDevices.mockResolvedValueOnce({
      pending: [],
      paired: [
        { deviceId: DEVICE_ID.toUpperCase(), approvedScopes: ["operator.read"], tokens: { t1: {} } },
      ],
    });

    const req = mockReq("GET", `/friday-next/health?deviceId=${DEVICE_ID.toLowerCase()}`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.devicePairing.status).toBe("ok");
  });

  // --- Node pairing: paired + healthy ---

  it("returns ok when node is paired with required caps and commands", async () => {
    mockListNodePairing.mockResolvedValueOnce({
      pending: [],
      paired: [
        {
          nodeId: NODE_ID,
          caps: ["location", "canvas"],
          commands: ["location.get", "canvas.present", "canvas.hide", "canvas.navigate", "canvas.eval", "canvas.snapshot", "canvas.a2ui.push", "canvas.a2ui.pushJSONL", "canvas.a2ui.reset"],
        },
      ],
    });

    const req = mockReq("GET", `/friday-next/health?nodeDeviceId=${NODE_ID}`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.ok).toBe(true);
    expect(body.nodePairing.status).toBe("ok");
    expect(body.nodePairing.capsValid).toBe(true);
    expect(body.nodePairing.commandsValid).toBe(true);
  });

  // --- Node pairing: degraded ---

  it("returns degraded when node is missing required caps", async () => {
    mockListNodePairing.mockResolvedValueOnce({
      pending: [],
      paired: [
        { nodeId: NODE_ID, caps: ["canvas"], commands: ["canvas.present"] },
      ],
    });

    const req = mockReq("GET", `/friday-next/health?nodeDeviceId=${NODE_ID}`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.ok).toBe(false);
    expect(body.nodePairing.status).toBe("degraded");
    expect(body.nodePairing.capsValid).toBe(false);
  });

  // --- Node pairing: pending + self-heal ---

  it("auto-approves pending node when selfHeal=true", async () => {
    mockListNodePairing.mockResolvedValueOnce({
      pending: [{ requestId: REQUEST_ID, nodeId: NODE_ID }],
      paired: [],
    });
    mockApproveNodePairing.mockResolvedValueOnce({ requestId: REQUEST_ID, node: { nodeId: NODE_ID } });

    const req = mockReq("GET", `/friday-next/health?nodeDeviceId=${NODE_ID}&selfHeal=true`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.nodePairing.status).toBe("ok");
    expect(body.repairActions).toHaveLength(1);
    expect(body.repairActions[0].component).toBe("nodePairing");
    expect(body.repairActions[0].result).toBe("ok");
  });

  // --- Node pairing: approveNodePairing returns null → degraded ---

  it("returns degraded when approveNodePairing returns null", async () => {
    mockListNodePairing.mockResolvedValueOnce({
      pending: [{ requestId: REQUEST_ID, nodeId: NODE_ID }],
      paired: [],
    });
    mockApproveNodePairing.mockResolvedValueOnce(null);

    const req = mockReq("GET", `/friday-next/health?nodeDeviceId=${NODE_ID}&selfHeal=true`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.nodePairing.status).toBe("degraded");
    expect(body.repairActions[0].result).toBe("failed");
  });

  // --- Node pairing: approveNodePairing returns empty object → degraded ---

  it("returns degraded when approveNodePairing returns empty object", async () => {
    mockListNodePairing.mockResolvedValueOnce({
      pending: [{ requestId: REQUEST_ID, nodeId: NODE_ID }],
      paired: [],
    });
    mockApproveNodePairing.mockResolvedValueOnce({});

    const req = mockReq("GET", `/friday-next/health?nodeDeviceId=${NODE_ID}&selfHeal=true`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.nodePairing.status).toBe("degraded");
    expect(body.repairActions[0].result).toBe("failed");
  });

  // --- Node pairing: forbidden → degraded ---

  it("returns degraded when approveNodePairing returns forbidden", async () => {
    mockListNodePairing.mockResolvedValueOnce({
      pending: [{ requestId: REQUEST_ID, nodeId: NODE_ID }],
      paired: [],
    });
    mockApproveNodePairing.mockResolvedValueOnce({ status: "forbidden", missingScope: "operator.admin" });

    const req = mockReq("GET", `/friday-next/health?nodeDeviceId=${NODE_ID}&selfHeal=true`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.nodePairing.status).toBe("degraded");
    expect(body.repairActions[0].result).toBe("failed");
  });

  // --- Node pairing: not_found ---

  it("returns not_found when node is not in paired or pending", async () => {
    mockListNodePairing.mockResolvedValueOnce({ pending: [], paired: [] });

    const req = mockReq("GET", `/friday-next/health?nodeDeviceId=${NODE_ID}`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.ok).toBe(false);
    expect(body.nodePairing.status).toBe("not_found");
  });

  // --- Node pairing: listNodePairing throws ---

  it("returns failed when listNodePairing throws", async () => {
    mockListNodePairing.mockRejectedValueOnce(new Error("EPIPE"));

    const req = mockReq("GET", `/friday-next/health?nodeDeviceId=${NODE_ID}`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.nodePairing.status).toBe("failed");
  });

  // --- Combined: device + node ---

  it("checks both device and node and reports overall ok", async () => {
    mockListDevices.mockResolvedValueOnce({
      pending: [],
      paired: [
        { deviceId: DEVICE_ID, approvedScopes: ["operator.read"], tokens: { t1: {} } },
      ],
    });
    mockListNodePairing.mockResolvedValueOnce({
      pending: [],
      paired: [
        {
          nodeId: NODE_ID,
          caps: ["location", "canvas"],
          commands: ["location.get", "canvas.present", "canvas.hide", "canvas.navigate", "canvas.eval", "canvas.snapshot", "canvas.a2ui.push", "canvas.a2ui.pushJSONL", "canvas.a2ui.reset"],
        },
      ],
    });

    const req = mockReq("GET", `/friday-next/health?deviceId=${DEVICE_ID}&nodeDeviceId=${NODE_ID}`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.ok).toBe(true);
    expect(body.devicePairing.status).toBe("ok");
    expect(body.nodePairing.status).toBe("ok");
  });

  it("reports ok=false when device is ok but node is degraded", async () => {
    mockListDevices.mockResolvedValueOnce({
      pending: [],
      paired: [
        { deviceId: DEVICE_ID, approvedScopes: ["operator.read"], tokens: { t1: {} } },
      ],
    });
    mockListNodePairing.mockResolvedValueOnce({
      pending: [],
      paired: [{ nodeId: NODE_ID, caps: [], commands: [] }],
    });

    const req = mockReq("GET", `/friday-next/health?deviceId=${DEVICE_ID}&nodeDeviceId=${NODE_ID}`, {
      authorization: "Bearer test-token",
    });
    const res = new MockRes() as unknown as ServerResponse;
    await handleHealth(req, res);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.ok).toBe(false);
    expect(body.devicePairing.status).toBe("ok");
    expect(body.nodePairing.status).toBe("degraded");
  });
});
