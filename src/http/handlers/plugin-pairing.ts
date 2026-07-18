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
 * reprinting the QR kills any leaked copy). The long-term `token` is deliberately
 * NOT in the response: `pair/claim` is its only exit (D12's whole point — no
 * pairing artifact that re-surfaces the permanent credential in logs/captures);
 * install.js gates on the plugin version, so every builder that reaches this
 * endpoint understands vouchers. 503 when public access is disabled or the
 * tunnel has not come up yet (`getPairingInfo()` still null).
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

  const { token: _token, ...pairingSansToken } = pairing;

  // `?voucher=0` — an ALREADY-paired app asking for the public-access coordinates it is
  // missing (upgrade self-heal): it holds the bearer, so it needs no voucher, and minting
  // one would silently invalidate an outstanding QR someone is mid-scan on.
  if ((new URL(req.url ?? "/", "http://localhost").searchParams.get("voucher") ?? "") === "0") {
    logger.info("pairing superset served — no voucher (already-paired client)");
    json(res, 200, pairingSansToken);
    return true;
  }

  const ticket = mintPairingVoucher();
  logger.info(`pairing superset served — fresh voucher minted (ttl ${ticket.ttlSec}s)`);
  json(res, 200, {
    ...pairingSansToken,
    pairingTicket: ticket.voucher,
    pairingTicketTtlSec: ticket.ttlSec,
  });
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
  // Verify the voucher FIRST; the rate limiter throttles only INVALID attempts. A global
  // pre-check would let anyone lock ALL pairing (a legit user with a fresh QR gets 429
  // because a stranger spammed garbage) — a zero-cost DoS. Brute force is hopeless against
  // a 128-bit voucher anyway; the limiter just slows scanners down.
  const outcome = claimPairingVoucher(voucher, now);
  if (outcome === "ok") {
    logger.info("pairing voucher claimed — bearer token delivered over pinned channel");
    json(res, 200, { token: pairing.token, lanUrl: pairing.lanUrl, publicUrl: pairing.publicUrl });
    return true;
  }
  if (outcome === "expired") {
    // A real (matching) voucher past its TTL — a legitimate scanner with an old QR, not a
    // guesser (matches are unforgeable). Don't count it against the abuse window.
    logger.warn("pairing voucher claim refused (expired)");
    json(res, 410, { error: "voucher_expired" });
    return true;
  }
  failedClaimTimes.push(now);
  logger.warn("pairing voucher claim refused (invalid)");
  json(res, claimRateLimited(now) ? 429 : 403, {
    error: claimRateLimited(now) ? "too_many_attempts" : "voucher_invalid",
  });
  return true;
}
