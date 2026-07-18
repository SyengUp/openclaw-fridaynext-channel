import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  handlePairClaim,
  handlePublicAccessPairing,
  resetPairClaimRateLimiter,
} from "./plugin-pairing.js";
import {
  claimPairingVoucher,
  clearPairingVoucher,
  mintPairingVoucher,
  setPairingVoucherDirForTest,
} from "../../public-access/pairing-voucher.js";

// The pairing route authenticates through the plugin runtime, which unit tests don't stand up
// (`getFridayNextRuntime()` throws). Auth itself is covered by the middleware's own tests; here
// we care about voucher behaviour, so treat the bearer as valid.
vi.mock("../middleware/auth.js", () => ({
  extractBearerToken: (req: { headers?: Record<string, string> }) =>
    (req.headers?.authorization ?? "").replace(/^Bearer /, "") || null,
}));

vi.mock("../../public-access/frpc-manager.js", () => ({
  getPairingInfo: () => ({
    v: 2,
    lanUrl: "http://192.168.1.2:18789",
    publicUrl: "https://sub.bj.gw.syengup.host",
    fingerprint: "ab".repeat(32),
    token: "real-bearer-token",
    subdomain: "sub",
  }),
}));

function fakeReq(body: unknown): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter;
  (req as { method?: string }).method = "POST";
  queueMicrotask(() => {
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function fakeRes(): { res: ServerResponse; result: () => { code: number; body: unknown } } {
  let code = 0;
  let raw = "";
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    end: (chunk?: string) => {
      code = (res as { statusCode: number }).statusCode;
      raw = chunk ?? "";
    },
  } as unknown as ServerResponse;
  return { res, result: () => ({ code, body: raw ? JSON.parse(raw) : null }) };
}

async function claim(voucher: string): Promise<{ code: number; body: unknown }> {
  const { res, result } = fakeRes();
  await handlePairClaim(fakeReq({ voucher }), res);
  return result();
}

// P1-14: the rate limiter must throttle only INVALID attempts — a valid voucher claim can
// never be blocked by strangers' garbage, otherwise 10 junk requests per 10 minutes would
// permanently lock the pairing flow for legitimate users (a zero-cost DoS).
describe("handlePairClaim rate limiting", () => {
  beforeEach(() => {
    setPairingVoucherDirForTest(mkdtempSync(join(tmpdir(), "fn-pairing-")));
    clearPairingVoucher();
    resetPairClaimRateLimiter();
  });

  it("valid claim succeeds even after the invalid-attempt window is saturated", async () => {
    const ticket = mintPairingVoucher();
    for (let i = 0; i < 15; i++) {
      const r = await claim(`fnpv1-${"0".repeat(32)}`);
      expect([403, 429]).toContain(r.code);
    }
    const ok = await claim(ticket.voucher);
    expect(ok.code).toBe(200);
    expect((ok.body as { token: string }).token).toBe("real-bearer-token");
  });

  it("invalid attempts get 429 once over the window limit", async () => {
    for (let i = 0; i < 10; i++) {
      await claim(`fnpv1-${"1".repeat(32)}`);
    }
    const r = await claim(`fnpv1-${"2".repeat(32)}`);
    expect(r.code).toBe(429);
    expect((r.body as { error: string }).error).toBe("too_many_attempts");
  });

  it("replay after a successful claim is refused (single-use)", async () => {
    const ticket = mintPairingVoucher();
    expect((await claim(ticket.voucher)).code).toBe(200);
    expect((await claim(ticket.voucher)).code).toBe(403);
  });
});

// 老用户升级续配: an already-paired app fetches its missing public-access coordinates with
// `?voucher=0`. It must NOT mint a voucher — doing so would invalidate an outstanding QR
// someone else is mid-scan on — and must not leak the long-term bearer either way.
describe("handlePublicAccessPairing voucher suppression", () => {
  beforeEach(() => {
    setPairingVoucherDirForTest(mkdtempSync(join(tmpdir(), "fn-pairing-")));
    clearPairingVoucher();
  });

  async function fetchPairing(url: string): Promise<{ code: number; body: unknown }> {
    const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter;
    (req as { method?: string; url?: string; headers?: Record<string, string> }).method = "GET";
    (req as { url?: string }).url = url;
    (req as { headers?: Record<string, string> }).headers = {
      authorization: "Bearer real-bearer-token",
    };
    const { res, result } = fakeRes();
    await handlePublicAccessPairing(req, res);
    return result();
  }

  it("serves the coordinates without minting a voucher when voucher=0", async () => {
    const outstanding = mintPairingVoucher();
    const { code, body } = await fetchPairing("/friday-next/public-access/pairing?voucher=0");
    expect(code).toBe(200);
    const payload = body as Record<string, unknown>;
    expect(payload.publicUrl).toBe("https://sub.bj.gw.syengup.host");
    expect(payload.fingerprint).toBe("ab".repeat(32));
    expect(payload.pairingTicket).toBeUndefined();
    expect(payload.token).toBeUndefined();
    // The pre-existing voucher survives — still claimable.
    expect(claimPairingVoucher(outstanding.voucher)).toBe("ok");
  });

  it("still mints a fresh voucher for the default (QR) fetch", async () => {
    const outstanding = mintPairingVoucher();
    const { code, body } = await fetchPairing("/friday-next/public-access/pairing");
    expect(code).toBe(200);
    const payload = body as Record<string, unknown>;
    expect(typeof payload.pairingTicket).toBe("string");
    expect(payload.pairingTicket).not.toBe(outstanding.voucher);
    expect(payload.token).toBeUndefined();
    // Minting replaces (= invalidates) the previous one.
    expect(claimPairingVoucher(outstanding.voucher)).toBe("invalid");
  });
});
