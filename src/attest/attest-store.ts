/**
 * App Attest state: one-time challenges, attested public keys (persistent), and
 * stateless HMAC session tokens.
 *
 * The session token is self-contained (payload + HMAC) so no session table is
 * needed and it survives restarts — the HMAC secret is a persistent random
 * per-gateway key (NOT the gateway auth token). Keeping it independent of the
 * bearer is deliberate: the bearer travels in the pairing QR, so deriving the
 * session secret from it would let anyone holding the QR/bearer forge a valid
 * session WITHOUT App Attest, collapsing the second factor. With an independent
 * secret, an attest session requires a genuine App Attest attestation, not just
 * the bearer. `nowMs` is threaded in for testability.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".openclaw", "friday-next", "attest");
const KEYS_FILE = join(DIR, "attested-keys.json");
const SECRET_FILE = join(DIR, "session-secret.key");
const CHALLENGE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 24 * 3600_000;

export type AttestedKey = { publicKey: string; signCount: number; environment: string };

// ---- attested keys (persistent) ----
let keys: Record<string, AttestedKey> = loadKeys();

function loadKeys(): Record<string, AttestedKey> {
  try {
    return JSON.parse(readFileSync(KEYS_FILE, "utf8")) as Record<string, AttestedKey>;
  } catch {
    return {};
  }
}
function persistKeys(): void {
  mkdirSync(DIR, { recursive: true });
  const tmp = KEYS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(keys));
  renameSync(tmp, KEYS_FILE);
}
export function getKey(keyId: string): AttestedKey | undefined {
  return keys[keyId];
}
export function saveKey(keyId: string, k: AttestedKey): void {
  keys[keyId] = k;
  persistKeys();
}
export function updateSignCount(keyId: string, signCount: number): void {
  const k = keys[keyId];
  if (k) {
    k.signCount = signCount;
    persistKeys();
  }
}
/** Test-only: reset in-memory key cache (does not touch disk). */
export function _resetKeysForTest(): void {
  keys = {};
}

// ---- one-time challenges (in-memory, TTL) ----
const challenges = new Map<string, number>(); // challenge -> expiry ms

export function issueChallenge(nowMs: number): string {
  for (const [c, exp] of challenges) if (exp < nowMs) challenges.delete(c); // opportunistic sweep
  const c = randomBytes(32).toString("base64url");
  challenges.set(c, nowMs + CHALLENGE_TTL_MS);
  return c;
}
/** Consume a challenge: true only if it was issued and unexpired (single use). */
export function consumeChallenge(challenge: string, nowMs: number): boolean {
  const exp = challenges.get(challenge);
  if (exp === undefined) return false;
  challenges.delete(challenge);
  return exp >= nowMs;
}

// ---- stateless HMAC session tokens ----
// Persistent random per-gateway secret — minted once, reused across restarts so
// existing app sessions survive a gateway bounce. Independent of the bearer by
// design (see file header). Cached in memory; the test seam avoids disk I/O.
let sessionSecretCache: Buffer | null = null;

function sessionSecret(): Buffer {
  if (sessionSecretCache) return sessionSecretCache;
  try {
    const buf = Buffer.from(readFileSync(SECRET_FILE, "utf8").trim(), "hex");
    if (buf.length === 32) {
      sessionSecretCache = buf;
      return buf;
    }
  } catch {
    // fall through to mint a fresh secret
  }
  const secret = randomBytes(32);
  mkdirSync(DIR, { recursive: true });
  const tmp = SECRET_FILE + ".tmp";
  writeFileSync(tmp, secret.toString("hex"), { mode: 0o600 });
  renameSync(tmp, SECRET_FILE);
  sessionSecretCache = secret;
  return secret;
}

/** Test-only: pin an in-memory session secret (or null to clear) so tests skip disk. */
export function _setSessionSecretForTest(secret: Buffer | null): void {
  sessionSecretCache = secret;
}

export function issueSession(keyId: string, nowMs: number): { token: string; exp: number } {
  const exp = nowMs + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ k: keyId, exp })).toString("base64url");
  const sig = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return { token: `${payload}.${sig}`, exp };
}

/** Verify a session token's HMAC and expiry. Constant-time signature compare. */
export function verifySession(token: string, nowMs: number): boolean {
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof obj.exp === "number" && obj.exp >= nowMs;
  } catch {
    return false;
  }
}
