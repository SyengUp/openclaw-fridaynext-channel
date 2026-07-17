/**
 * One-time pairing voucher (D12) — the QR carries THIS instead of the long-term
 * bearer token.
 *
 * Threat model: a pairing QR can leak (photo over a shoulder, screenshot in a
 * chat). With the permanent token embedded, one leak = permanent gateway access.
 * A voucher bounds the damage: 10-minute TTL, single use, and minting a new one
 * atomically invalidates the old (作废重出 — reprint the QR and any leaked copy
 * is dead). The app exchanges the voucher for the real token over the pinned TLS
 * channel (`POST /friday-next/pair/claim`), so the token itself only ever travels
 * inside a connection whose leaf certificate the app has already pinned.
 *
 * Storage: single-outstanding-voucher, disk-backed (survives a gateway restart
 * within the TTL) under the public-access data dir. Only the SHA-256 of the code
 * is persisted — a disk read never yields a claimable voucher.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VOUCHER_TTL_MS = 10 * 60_000; // D12: 10 minutes
let dataDir = join(homedir(), ".openclaw", "friday-next", "public-access");
const storePath = (): string => join(dataDir, "pairing-voucher.json");

/** Vitest: isolate the disk store so tests never touch a live gateway's voucher. */
export function setPairingVoucherDirForTest(dir: string): void {
  dataDir = dir;
}

type StoredVoucher = { codeHash: string; expiresAt: number };

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function loadStored(): StoredVoucher | null {
  try {
    const v = JSON.parse(readFileSync(storePath(), "utf8")) as StoredVoucher;
    return typeof v?.codeHash === "string" && typeof v?.expiresAt === "number" ? v : null;
  } catch {
    return null;
  }
}

/** Mint a fresh voucher, replacing (= invalidating) any outstanding one. */
export function mintPairingVoucher(nowMs = Date.now()): { voucher: string; expiresAt: number; ttlSec: number } {
  const voucher = "fnpv1-" + randomBytes(16).toString("hex");
  const expiresAt = nowMs + VOUCHER_TTL_MS;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ codeHash: sha256Hex(voucher), expiresAt } satisfies StoredVoucher));
  return { voucher, expiresAt, ttlSec: Math.floor(VOUCHER_TTL_MS / 1000) };
}

export type VoucherClaimResult = "ok" | "expired" | "invalid";

/** Single-use claim: a successful claim deletes the voucher (second claim → invalid). */
export function claimPairingVoucher(code: string, nowMs = Date.now()): VoucherClaimResult {
  const stored = loadStored();
  if (!stored || typeof code !== "string" || !code.trim()) return "invalid";
  if (sha256Hex(code.trim()) !== stored.codeHash) return "invalid";
  // Matched voucher is consumed regardless of outcome — an expired-but-matching
  // claim also burns it, so a leaked old QR can't be retried into a race.
  try {
    unlinkSync(storePath());
  } catch {
    /* already gone */
  }
  return stored.expiresAt > nowMs ? "ok" : "expired";
}

/** Vitest / ops: drop any outstanding voucher. */
export function clearPairingVoucher(): void {
  if (existsSync(storePath())) {
    try {
      unlinkSync(storePath());
    } catch {
      /* ignore */
    }
  }
}
