import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setMockRuntime } from "../../test-support/mock-runtime.js";
import { __setMockNodePairingForTests } from "../../agent/node-pairing-bridge.js";

const { mockList, mockApprove } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockApprove: vi.fn(),
}));

import { handleNodesApprove } from "./nodes-approve.js";

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

const NODE_ID = "a80b8c4b305fb02c5772c409c6dfcbacde691b61557f7779511ad1a5be8fdf06";
const REQUEST_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

describe("handleNodesApprove", () => {
  beforeEach(() => {
    setMockRuntime();
    vi.clearAllMocks();
    __setMockNodePairingForTests({
      listNodePairing: mockList,
      approveNodePairing: mockApprove,
    });
  });

  it("returns 405 on non-POST", async () => {
    const req = { method: "GET", headers: {} } as IncomingMessage;
    const res = new MockRes() as unknown as ServerResponse;
    await handleNodesApprove(req, res);
    expect((res as unknown as MockRes).statusCode).toBe(405);
  });

  it("returns 401 for missing auth", async () => {
    const req = mockReq("POST");
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleNodesApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ nodeId: NODE_ID }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(401);
  });

  it("returns 400 for missing body", async () => {
    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleNodesApprove(req as unknown as IncomingMessage, res);
    req.end("");
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(400);
  });

  it("returns 400 for missing nodeId", async () => {
    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleNodesApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({}));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(400);
    expect(JSON.parse((res as unknown as MockRes).body).error).toContain("nodeId");
  });

  it("returns 502 when listNodePairing fails", async () => {
    mockList.mockRejectedValueOnce(new Error("ENOENT"));

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleNodesApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ nodeId: NODE_ID }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(502);
    expect(JSON.parse((res as unknown as MockRes).body).error).toContain("Failed to list nodes");
  });

  it("returns 404 when listNodePairing returns data without matching node", async () => {
    mockList.mockResolvedValueOnce({
      pending: [{ requestId: "x", nodeId: "UNMATCHED" }],
      paired: [],
    });

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleNodesApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ nodeId: NODE_ID }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(404);
  });

  it("returns 404 when nodeId not in pending or paired with caps", async () => {
    mockList.mockResolvedValueOnce({
      pending: [{ requestId: "uuid-1", nodeId: "OTHER_NODE" }],
      paired: [{ nodeId: "OTHER_NODE", approvedAtMs: 1, caps: ["canvas"], commands: [] }],
    });

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleNodesApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ nodeId: NODE_ID }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(404);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.error).toContain("No pending node found");
  });

  it("returns 404 when pending is empty and paired has empty caps/commands", async () => {
    mockList.mockResolvedValueOnce({
      pending: [],
      paired: [{ nodeId: NODE_ID, approvedAtMs: 1, caps: [], commands: [] }],
    });

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleNodesApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ nodeId: NODE_ID }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(404);
  });

  it("returns 200 with alreadyApproved when node in paired with caps", async () => {
    mockList.mockResolvedValueOnce({
      pending: [],
      paired: [
        { nodeId: NODE_ID, approvedAtMs: 100, caps: ["canvas"], commands: ["canvas.present"] },
      ],
    });

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleNodesApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ nodeId: NODE_ID }));
    await p;

    expect((res as unknown as MockRes).statusCode).toBe(200);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.ok).toBe(true);
    expect(body.alreadyApproved).toBe(true);
    expect(body.caps).toEqual(["canvas"]);
    expect(body.commands).toEqual(["canvas.present"]);
  });

  it("returns 502 when approveNodePairing fails", async () => {
    mockList.mockResolvedValueOnce({
      pending: [{ requestId: REQUEST_ID, nodeId: NODE_ID }],
      paired: [],
    });
    mockApprove.mockRejectedValueOnce(new Error("unknown requestId"));

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleNodesApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ nodeId: NODE_ID }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(502);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.error).toContain("Node approval failed");
    expect(body.detail).toBe("unknown requestId");
  });

  it("returns 404 when approveNodePairing returns null", async () => {
    mockList.mockResolvedValueOnce({
      pending: [{ requestId: REQUEST_ID, nodeId: NODE_ID }],
      paired: [],
    });
    mockApprove.mockResolvedValueOnce(null);

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleNodesApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ nodeId: NODE_ID }));
    await p;
    expect((res as unknown as MockRes).statusCode).toBe(404);
  });

  it("succeeds with complete flow", async () => {
    mockList.mockResolvedValueOnce({
      pending: [{ requestId: REQUEST_ID, nodeId: NODE_ID }],
      paired: [],
    });
    mockApprove.mockResolvedValueOnce({
      requestId: REQUEST_ID,
      node: { nodeId: NODE_ID, approvedAtMs: 1778571972361 },
    });

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleNodesApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ nodeId: NODE_ID }));
    await p;

    expect((res as unknown as MockRes).statusCode).toBe(200);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.ok).toBe(true);
    expect(body.nodeId).toBe(NODE_ID.toUpperCase());
    expect(body.requestId).toBe(REQUEST_ID);
  });

  it("normalizes nodeId case-insensitively in pending", async () => {
    mockList.mockResolvedValueOnce({
      pending: [{ requestId: REQUEST_ID, nodeId: NODE_ID.toUpperCase() }],
      paired: [],
    });
    mockApprove.mockResolvedValueOnce({
      requestId: REQUEST_ID,
      node: { nodeId: NODE_ID.toUpperCase(), approvedAtMs: 1 },
    });

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleNodesApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ nodeId: NODE_ID.toLowerCase() }));
    await p;

    expect((res as unknown as MockRes).statusCode).toBe(200);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.ok).toBe(true);
  });

  it("normalizes nodeId case-insensitively in paired", async () => {
    mockList.mockResolvedValueOnce({
      pending: [],
      paired: [{ nodeId: NODE_ID.toUpperCase(), approvedAtMs: 1, caps: ["canvas"], commands: [] }],
    });

    const req = mockReq("POST", { authorization: "Bearer test-token" });
    const res = new MockRes() as unknown as ServerResponse;
    const p = handleNodesApprove(req as unknown as IncomingMessage, res);
    req.end(JSON.stringify({ nodeId: NODE_ID.toLowerCase() }));
    await p;

    expect((res as unknown as MockRes).statusCode).toBe(200);
    const body = JSON.parse((res as unknown as MockRes).body);
    expect(body.ok).toBe(true);
    expect(body.alreadyApproved).toBe(true);
  });
});
