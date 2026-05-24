/**
 * E2E test: 模拟 iOS 两步自动批准流程 (device-approve → nodes-approve)
 *
 * iOS 端 connect 成功后会调用 performPostConnectHealthCheckIfNeeded()：
 *   1. GET /friday-next/health?deviceId=...&nodeDeviceId=... (selfHeal 默认 true)
 *   2. 如果 devicePairing.status == "pending" → POST /friday-next/device-approve
 *   3. 如果 nodePairing.status == "pending" → POST /friday-next/nodes-approve
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppSimulator } from "../test-support/app-simulator.js";
import { createTempHistoryDir, removeTempHistoryDir, setMockRuntime } from "../test-support/mock-runtime.js";
import { __setMockNodePairingForTests } from "../agent/node-pairing-bridge.js";

const FAKE_DEVICE_ID = "a80b8c4b305fb02c5772c409c6dfcbacde691b61557f7779511ad1a5be8fdf06";
const DEVICE_REQUEST_ID = "12f150e8-b1bc-4688-be23-e3a7fa8b9e51";
const NODE_REQUEST_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

const { mockListDevices, mockApproveDevice } = vi.hoisted(() => ({
  mockListDevices: vi.fn(),
  mockApproveDevice: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/device-bootstrap", () => ({
  listDevicePairing: mockListDevices,
  approveDevicePairing: mockApproveDevice,
}));

describe("e2e two-step auto-approval", () => {
  let historyDir = "";

  beforeEach(() => {
    historyDir = createTempHistoryDir();
    setMockRuntime({ historyDir, authToken: "test-token" });
    vi.clearAllMocks();
    // 默认：设备和节点都不在 pending/paired 中
    mockListDevices.mockResolvedValue({ pending: [], paired: [] });
    mockApproveDevice.mockResolvedValue({ status: "approved", requestId: DEVICE_REQUEST_ID });
  });

  afterEach(() => {
    removeTempHistoryDir(historyDir);
  });

  // ── Step 1: Device Approve ───────────────────────────────────────

  it("Step 1: POST /friday-next/device-approve 成功批准设备", async () => {
    mockListDevices.mockResolvedValueOnce({
      pending: [{ requestId: DEVICE_REQUEST_ID, deviceId: FAKE_DEVICE_ID }],
      paired: [],
    });
    mockApproveDevice.mockResolvedValueOnce({
      status: "approved",
      requestId: DEVICE_REQUEST_ID,
      device: { deviceId: FAKE_DEVICE_ID, approvedAtMs: 1700000000000 },
    });

    const app = createAppSimulator({ token: "test-token" });
    const res = await app.rawRequest({
      method: "POST",
      path: "/friday-next/device-approve",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: FAKE_DEVICE_ID }),
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.deviceId).toBe(FAKE_DEVICE_ID.toUpperCase());
    expect(body.requestId).toBe(DEVICE_REQUEST_ID);
    expect(mockApproveDevice).toHaveBeenCalledWith(DEVICE_REQUEST_ID);
  });

  it("Step 1: device 已在 paired 列表中时返回 alreadyApproved", async () => {
    mockListDevices.mockResolvedValueOnce({
      pending: [],
      paired: [{ deviceId: FAKE_DEVICE_ID, approvedAtMs: 1700000000000 }],
    });

    const app = createAppSimulator({ token: "test-token" });
    const res = await app.rawRequest({
      method: "POST",
      path: "/friday-next/device-approve",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: FAKE_DEVICE_ID }),
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.alreadyApproved).toBe(true);
    expect(mockApproveDevice).not.toHaveBeenCalled();
  });

  it("Step 1: device 不在 pending/paired 中时返回 404", async () => {
    mockListDevices.mockResolvedValueOnce({ pending: [], paired: [] });

    const app = createAppSimulator({ token: "test-token" });
    const res = await app.rawRequest({
      method: "POST",
      path: "/friday-next/device-approve",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: FAKE_DEVICE_ID }),
    });

    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("No pending device found");
    expect(body.deviceId).toBe(FAKE_DEVICE_ID.toUpperCase());
  });

  // ── Step 2: Node Approve ─────────────────────────────────────────

  it("Step 2: POST /friday-next/nodes-approve 成功批准节点", async () => {
    const mockListNodePairing = vi.fn().mockResolvedValueOnce({
      pending: [{ requestId: NODE_REQUEST_ID, nodeId: FAKE_DEVICE_ID }],
      paired: [],
    });
    const mockApproveNodePairing = vi.fn().mockResolvedValueOnce({
      requestId: NODE_REQUEST_ID,
      node: { nodeId: FAKE_DEVICE_ID, approvedAtMs: 1700000000000 },
    });

    __setMockNodePairingForTests({
      listNodePairing: mockListNodePairing,
      approveNodePairing: mockApproveNodePairing,
    });

    const app = createAppSimulator({ token: "test-token" });
    const res = await app.rawRequest({
      method: "POST",
      path: "/friday-next/nodes-approve",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: FAKE_DEVICE_ID }),
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.nodeId).toBe(FAKE_DEVICE_ID.toUpperCase());
    expect(body.requestId).toBe(NODE_REQUEST_ID);
    expect(mockApproveNodePairing).toHaveBeenCalledWith(NODE_REQUEST_ID, {
      callerScopes: ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
    });
  });

  it("Step 2: node 已在 paired 中且有 caps 时返回 alreadyApproved", async () => {
    const mockListNodePairing = vi.fn().mockResolvedValueOnce({
      pending: [],
      paired: [{
        nodeId: FAKE_DEVICE_ID,
        approvedAtMs: 1700000000000,
        caps: ["location", "canvas"],
        commands: ["canvas.present"],
      }],
    });
    const mockApproveNodePairing = vi.fn();

    __setMockNodePairingForTests({
      listNodePairing: mockListNodePairing,
      approveNodePairing: mockApproveNodePairing,
    });

    const app = createAppSimulator({ token: "test-token" });
    const res = await app.rawRequest({
      method: "POST",
      path: "/friday-next/nodes-approve",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: FAKE_DEVICE_ID }),
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.alreadyApproved).toBe(true);
    expect(body.caps).toEqual(["location", "canvas"]);
    expect(mockApproveNodePairing).not.toHaveBeenCalled();
  });

  it("Step 2: node 不在 pending/paired 中时返回 404", async () => {
    const mockListNodePairing = vi.fn().mockResolvedValueOnce({
      pending: [],
      paired: [],
    });
    const mockApproveNodePairing = vi.fn();

    __setMockNodePairingForTests({
      listNodePairing: mockListNodePairing,
      approveNodePairing: mockApproveNodePairing,
    });

    const app = createAppSimulator({ token: "test-token" });
    const res = await app.rawRequest({
      method: "POST",
      path: "/friday-next/nodes-approve",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: FAKE_DEVICE_ID }),
    });

    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("No pending node found");
  });

  // ── Combined: full iOS flow simulation ───────────────────────────

  it("完整两步流程: device-approve → nodes-approve 串行成功", async () => {
    // Step 1 mock: 设备在 pending 中
    mockListDevices.mockResolvedValueOnce({
      pending: [{ requestId: DEVICE_REQUEST_ID, deviceId: FAKE_DEVICE_ID }],
      paired: [],
    });
    mockApproveDevice.mockResolvedValueOnce({
      status: "approved",
      requestId: DEVICE_REQUEST_ID,
      device: { deviceId: FAKE_DEVICE_ID, approvedAtMs: 1700000000000 },
    });

    // Step 2 mock: 节点在 pending 中
    const mockListNodePairing = vi.fn().mockResolvedValueOnce({
      pending: [{ requestId: NODE_REQUEST_ID, nodeId: FAKE_DEVICE_ID }],
      paired: [],
    });
    const mockApproveNodePairing = vi.fn().mockResolvedValueOnce({
      requestId: NODE_REQUEST_ID,
      node: { nodeId: FAKE_DEVICE_ID, approvedAtMs: 1700000000001 },
    });
    __setMockNodePairingForTests({
      listNodePairing: mockListNodePairing,
      approveNodePairing: mockApproveNodePairing,
    });

    const app = createAppSimulator({ token: "test-token" });

    // Step 1: 批准设备
    const step1 = await app.rawRequest({
      method: "POST",
      path: "/friday-next/device-approve",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: FAKE_DEVICE_ID }),
    });
    expect(step1.status).toBe(200);
    expect(JSON.parse(step1.body).ok).toBe(true);
    expect(mockApproveDevice).toHaveBeenCalledTimes(1);

    // Step 2: 批准节点
    const step2 = await app.rawRequest({
      method: "POST",
      path: "/friday-next/nodes-approve",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: FAKE_DEVICE_ID }),
    });
    expect(step2.status).toBe(200);
    expect(JSON.parse(step2.body).ok).toBe(true);
    expect(mockApproveNodePairing).toHaveBeenCalledTimes(1);
  });

  // ── Auth tests ───────────────────────────────────────────────────

  it("device-approve: 正确 token 正常批准", async () => {
    mockListDevices.mockResolvedValueOnce({
      pending: [{ requestId: DEVICE_REQUEST_ID, deviceId: FAKE_DEVICE_ID }],
      paired: [],
    });
    mockApproveDevice.mockResolvedValueOnce({
      status: "approved",
      requestId: DEVICE_REQUEST_ID,
      device: { deviceId: FAKE_DEVICE_ID, approvedAtMs: 1700000000000 },
    });

    const app = createAppSimulator({ token: "test-token" });
    const res = await app.rawRequest({
      method: "POST",
      path: "/friday-next/device-approve",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: FAKE_DEVICE_ID }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it("device-approve: 错误 token 返回 401", async () => {
    const app = createAppSimulator({ token: "wrong-token" });
    const res = await app.rawRequest({
      method: "POST",
      path: "/friday-next/device-approve",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: FAKE_DEVICE_ID }),
    });
    expect(res.status).toBe(401);
  });

  // ── Health endpoint with selfHeal ────────────────────────────────

  it("GET /friday-next/health?selfHeal=true 自动批准 pending device", async () => {
    mockListDevices.mockResolvedValueOnce({
      pending: [{ requestId: DEVICE_REQUEST_ID, deviceId: FAKE_DEVICE_ID }],
      paired: [],
    });
    mockApproveDevice.mockResolvedValueOnce({
      status: "approved",
      requestId: DEVICE_REQUEST_ID,
      device: { deviceId: FAKE_DEVICE_ID, approvedAtMs: 1700000000000 },
    });

    const app = createAppSimulator({ token: "test-token" });
    const res = await app.rawRequest({
      method: "GET",
      path: `/friday-next/health?deviceId=${FAKE_DEVICE_ID}&selfHeal=true`,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.devicePairing.status).toBe("ok");
    expect(body.devicePairing.detail).toContain("auto-approved");
    expect(body.repairActions).toHaveLength(1);
    expect(body.repairActions[0].component).toBe("devicePairing");
    expect(body.repairActions[0].result).toBe("ok");
    expect(mockApproveDevice).toHaveBeenCalledWith(DEVICE_REQUEST_ID);
  });

  it("GET /friday-next/health 不带 selfHeal 时不自动批准 (只返回 pending)", async () => {
    mockListDevices.mockResolvedValueOnce({
      pending: [{ requestId: DEVICE_REQUEST_ID, deviceId: FAKE_DEVICE_ID }],
      paired: [],
    });

    const app = createAppSimulator({ token: "test-token" });
    const res = await app.rawRequest({
      method: "GET",
      path: `/friday-next/health?deviceId=${FAKE_DEVICE_ID}`,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.devicePairing.status).toBe("pending");
    expect(body.devicePairing.detail).toContain("pending approval");
    expect(mockApproveDevice).not.toHaveBeenCalled();
    // ok 仍为 true，因为 pending 也视为 ok
    expect(body.ok).toBe(true);
  });

  it("GET /friday-next/health?selfHeal=true 自动批准 pending node", async () => {
    mockListDevices.mockResolvedValue({ pending: [], paired: [] }); // device 不相关

    const mockListNodePairing = vi.fn().mockResolvedValueOnce({
      pending: [{ requestId: NODE_REQUEST_ID, nodeId: FAKE_DEVICE_ID }],
      paired: [],
    });
    const mockApproveNodePairing = vi.fn().mockResolvedValueOnce({
      requestId: NODE_REQUEST_ID,
      node: { nodeId: FAKE_DEVICE_ID },
    });
    __setMockNodePairingForTests({
      listNodePairing: mockListNodePairing,
      approveNodePairing: mockApproveNodePairing,
    });

    const app = createAppSimulator({ token: "test-token" });
    const res = await app.rawRequest({
      method: "GET",
      path: `/friday-next/health?nodeDeviceId=${FAKE_DEVICE_ID}&selfHeal=true`,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.nodePairing.status).toBe("ok");
    expect(body.nodePairing.detail).toContain("auto-approved");
    expect(body.repairActions).toHaveLength(1);
    expect(body.repairActions[0].component).toBe("nodePairing");
    expect(body.repairActions[0].result).toBe("ok");
  });

  it("GET /friday-next/health?selfHeal=true 同时自动批准 device 和 node", async () => {
    // Device is pending
    mockListDevices.mockResolvedValueOnce({
      pending: [{ requestId: DEVICE_REQUEST_ID, deviceId: FAKE_DEVICE_ID }],
      paired: [],
    });
    mockApproveDevice.mockResolvedValueOnce({
      status: "approved",
      requestId: DEVICE_REQUEST_ID,
      device: { deviceId: FAKE_DEVICE_ID, approvedAtMs: 1700000000000 },
    });

    // Node is pending
    const mockListNodePairing = vi.fn().mockResolvedValueOnce({
      pending: [{ requestId: NODE_REQUEST_ID, nodeId: FAKE_DEVICE_ID }],
      paired: [],
    });
    const mockApproveNodePairing = vi.fn().mockResolvedValueOnce({
      requestId: NODE_REQUEST_ID,
      node: { nodeId: FAKE_DEVICE_ID },
    });
    __setMockNodePairingForTests({
      listNodePairing: mockListNodePairing,
      approveNodePairing: mockApproveNodePairing,
    });

    const app = createAppSimulator({ token: "test-token" });
    const res = await app.rawRequest({
      method: "GET",
      path: `/friday-next/health?deviceId=${FAKE_DEVICE_ID}&nodeDeviceId=${FAKE_DEVICE_ID}&selfHeal=true`,
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.devicePairing.status).toBe("ok");
    expect(body.nodePairing.status).toBe("ok");
    expect(body.repairActions).toHaveLength(2);
    expect(body.repairActions[0].component).toBe("devicePairing");
    expect(body.repairActions[1].component).toBe("nodePairing");
  });
});
