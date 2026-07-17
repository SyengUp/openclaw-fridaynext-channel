import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken } from "../middleware/auth.js";
import { getPairingInfo } from "../../public-access/frpc-manager.js";
import { claimPairingVoucher, mintPairingVoucher } from "../../public-access/pairing-voucher.js";
import { createFridayNextLogger } from "../../logging.js";

const logger = createFridayNextLogger("pairing", "info");

function json(res: ServerResponse, code: number, obj: unknown): void {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

/**
 * GET /friday-next/public-access/pairing
 *
 * Returns the public-access pairing superset — `{v, lanUrl, publicUrl,
 * fingerprint, pairingTicket, subdomain}` — the shape the app's QR parser decodes
 * (`OnboardingQRPayload`). Since D12 landed, the payload carries a **10-minute
 * one-time pairing voucher** instead of the long-term bearer token: the scanner
 * exchanges it via `POST /friday-next/pair/claim` over the pinned TLS channel.
 * Every fetch mints a fresh voucher and invalidates the previous one (作废重出 —
 * reprinting the QR kills any leaked copy). `token` is still included for
 * transitional compatibility with older `install.js` QR builders; it is
 * Bearer-authed either way, so only a caller that already holds the token (the
 * owner) can fetch this. 503 when public access is disabled or the tunnel has
 * not come up yet (`getPairingInfo()` still null).
 */
export async function handlePublicAccessPairing(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET") {
    json(res, 405, { error: "Method Not Allowed" });
    return true;
  }
  if (!extractBearerToken(req)) {
    json(res, 401, { error: "Unauthorized: bearer token mismatch" });
    return true;
  }

  const pairing = getPairingInfo();
  if (!pairing) {
    json(res, 503, {
      error: "public access not available",
      detail:
        "channels.friday-next.publicAccess.enabled is false, or the tunnel has not come up yet",
    });
    return true;
  }

  const ticket = mintPairingVoucher();
  logger.info(`pairing superset served — fresh voucher minted (ttl ${ticket.ttlSec}s)`);
  json(res, 200, { ...pairing, pairingTicket: ticket.voucher, pairingTicketTtlSec: ticket.ttlSec });
  return true;
}

// ——— voucher claim rate limiting (belt-and-braces; the voucher itself is 128-bit
// random). Sliding window per process: after MAX_FAILURES failed claims within
// WINDOW_MS, every claim is refused until the window drains. ———
const CLAIM_WINDOW_MS = 10 * 60_000;
const CLAIM_MAX_FAILURES = 10;
let failedClaimTimes: number[] = [];

function claimRateLimited(nowMs: number): boolean {
  failedClaimTimes = failedClaimTimes.filter((t) => nowMs - t < CLAIM_WINDOW_MS);
  return failedClaimTimes.length >= CLAIM_MAX_FAILURES;
}

/** Vitest: reset the limiter between tests. */
export function resetPairClaimRateLimiter(): void {
  failedClaimTimes = [];
}

function readBody(req: IncomingMessage, limit = 8_192): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c: Buffer) => {
      b += c;
      if (b.length > limit) req.destroy();
    });
    req.on("end", () => resolve(b));
    req.on("error", () => resolve(""));
  });
}

/**
 * POST /friday-next/pair/claim — exchange a one-time pairing voucher for the real
 * bearer token (D12: the token travels only inside the pinned TLS channel, never
 * in the QR). Deliberately UNAUTHENTICATED (the caller doesn't have the token
 * yet — the voucher IS the credential) and attest-exempt (the app can't attest
 * before it can authenticate); single-use + 10min TTL + rate limit bound abuse.
 */
export async function handlePairClaim(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method Not Allowed" });
    return true;
  }
  const now = Date.now();
  if (claimRateLimited(now)) {
    json(res, 429, { error: "too_many_attempts" });
    return true;
  }
  let voucher = "";
  try {
    const body = JSON.parse((await readBody(req)) || "{}") as { voucher?: unknown };
    voucher = typeof body.voucher === "string" ? body.voucher.trim() : "";
  } catch {
    /* fall through to invalid */
  }
  const pairing = getPairingInfo();
  if (!pairing?.token) {
    json(res, 503, { error: "pairing_unavailable" });
    return true;
  }
  const outcome = claimPairingVoucher(voucher, now);
  if (outcome === "ok") {
    logger.info("pairing voucher claimed — bearer token delivered over pinned channel");
    json(res, 200, { token: pairing.token, lanUrl: pairing.lanUrl, publicUrl: pairing.publicUrl });
    return true;
  }
  failedClaimTimes.push(now);
  logger.warn(`pairing voucher claim refused (${outcome})`);
  json(res, outcome === "expired" ? 410 : 403, {
    error: outcome === "expired" ? "voucher_expired" : "voucher_invalid",
  });
  return true;
}
