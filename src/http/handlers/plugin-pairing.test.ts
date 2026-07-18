import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handlePairClaim, resetPairClaimRateLimiter } from "./plugin-pairing.js";
import {
  clearPairingVoucher,
  mintPairingVoucher,
  setPairingVoucherDirForTest,
} from "../../public-access/pairing-voucher.js";

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
