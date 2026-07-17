import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimPairingVoucher,
  clearPairingVoucher,
  mintPairingVoucher,
  setPairingVoucherDirForTest,
} from "./pairing-voucher.js";

describe("pairing voucher（D12 一次性配对券）", () => {
  beforeEach(() => {
    setPairingVoucherDirForTest(mkdtempSync(join(tmpdir(), "fn-voucher-")));
    clearPairingVoucher();
  });

  it("mints and claims once; second claim is invalid (single use)", () => {
    const { voucher } = mintPairingVoucher();
    expect(voucher).toMatch(/^fnpv1-[0-9a-f]{32}$/);
    expect(claimPairingVoucher(voucher)).toBe("ok");
    expect(claimPairingVoucher(voucher)).toBe("invalid");
  });

  it("rejects an expired voucher (10 min TTL) and burns it", () => {
    const t0 = 1_000_000;
    const { voucher } = mintPairingVoucher(t0);
    expect(claimPairingVoucher(voucher, t0 + 10 * 60_000 + 1)).toBe("expired");
    // burned — even a within-TTL retry is dead
    expect(claimPairingVoucher(voucher, t0 + 1)).toBe("invalid");
  });

  it("claims right at the TTL boundary minus one ms", () => {
    const t0 = 5_000;
    const { voucher, expiresAt } = mintPairingVoucher(t0);
    expect(claimPairingVoucher(voucher, expiresAt - 1)).toBe("ok");
  });

  it("re-minting invalidates the outstanding voucher（作废重出）", () => {
    const a = mintPairingVoucher().voucher;
    const b = mintPairingVoucher().voucher;
    expect(claimPairingVoucher(a)).toBe("invalid");
    expect(claimPairingVoucher(b)).toBe("ok");
  });

  it("rejects garbage and empty codes without consuming the voucher", () => {
    const { voucher } = mintPairingVoucher();
    expect(claimPairingVoucher("")).toBe("invalid");
    expect(claimPairingVoucher("fnpv1-" + "0".repeat(32))).toBe("invalid");
    expect(claimPairingVoucher(voucher)).toBe("ok"); // still claimable — misses don't burn it
  });

  it("claim with no outstanding voucher is invalid", () => {
    expect(claimPairingVoucher("fnpv1-" + "a".repeat(32))).toBe("invalid");
  });
});
