import { describe, expect, it, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";

vi.mock("../../attest/attest-store.js", () => ({
  verifySession: vi.fn(),
}));

import { verifySession } from "../../attest/attest-store.js";
import { handleEdgeAttestVerify } from "./edge-attest-verify.js";

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

function makeReq(
  headers: Record<string, string | string[]> = {},
  remoteAddress = "127.0.0.1",
): IncomingMessage {
  return {
    method: "GET",
    url: "/friday-next/edge/verify-attest",
    headers,
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

function run(
  headers: Record<string, string | string[]> = {},
  remoteAddress = "127.0.0.1",
): { status: number; body: string } {
  const res = new MockRes();
  const handled = handleEdgeAttestVerify(makeReq(headers, remoteAddress), res as unknown as ServerResponse);
  expect(handled).toBe(true);
  return { status: res.statusCode, body: res.body };
}

describe("handleEdgeAttestVerify", () => {
  beforeEach(() => {
    vi.mocked(verifySession).mockReset();
  });

  it("rejects non-loopback remote addresses before verifying", () => {
    const r = run({ "x-fridaynext-attest": "tok" }, "203.0.113.7");
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ error: "loopback_required" });
    expect(verifySession).not.toHaveBeenCalled();
  });

  it("accepts ::1 as loopback", () => {
    vi.mocked(verifySession).mockReturnValue(true);
    const r = run({ "x-fridaynext-attest": "tok" }, "::1");
    expect(r.status).toBe(200);
  });

  it("rejects public-marker requests even on loopback (never a public oracle)", () => {
    vi.mocked(verifySession).mockReturnValue(true);
    const r = run(
      { "x-fridaynext-attest": "tok", "x-fridaynext-public": "1" },
      "127.0.0.1",
    );
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ error: "not_available_publicly" });
    expect(verifySession).not.toHaveBeenCalled();
  });

  it("returns 401 when the attest header is missing", () => {
    const r = run({}, "127.0.0.1");
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)).toEqual({ error: "attest_token_required" });
    expect(verifySession).not.toHaveBeenCalled();
  });

  it("returns 200 when verifySession accepts the token", () => {
    vi.mocked(verifySession).mockReturnValue(true);
    const r = run({ "x-fridaynext-attest": "tok-good" }, "127.0.0.1");
    expect(r.status).toBe(200);
    expect(verifySession).toHaveBeenCalledWith("tok-good", expect.any(Number));
  });

  it("returns 401 when verifySession rejects the token", () => {
    vi.mocked(verifySession).mockReturnValue(false);
    const r = run({ "x-fridaynext-attest": "tok-bad" }, "127.0.0.1");
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)).toEqual({ error: "invalid_attest_session" });
  });

  it("collapses an array-valued attest header to the first entry", () => {
    vi.mocked(verifySession).mockReturnValue(true);
    const r = run({ "x-fridaynext-attest": ["first", "second"] }, "127.0.0.1");
    expect(r.status).toBe(200);
    expect(verifySession).toHaveBeenCalledWith("first", expect.any(Number));
  });
});
