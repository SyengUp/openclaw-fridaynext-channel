import { beforeEach, describe, expect, it } from "vitest";
import {
  _setSessionSecretForTest,
  consumeChallenge,
  issueChallenge,
  issueSession,
  verifySession,
} from "./attest-store.js";

const T0 = 1_700_000_000_000;

describe("session tokens", () => {
  // Pin an in-memory secret so tests never touch ~/.openclaw and are deterministic.
  beforeEach(() => _setSessionSecretForTest(Buffer.alloc(32, 7)));

  it("issues a token that verifies", () => {
    const { token, exp } = issueSession("keyA", T0);
    expect(exp).toBeGreaterThan(T0);
    expect(verifySession(token, T0)).toBe(true);
  });

  it("session secret is independent of the gateway bearer token", () => {
    // Deliberate: the bearer travels in the pairing QR, so a session must NOT be
    // forgeable from it. A token issued under one secret is rejected under another —
    // and crucially the secret is a per-gateway random key, not the bearer.
    const { token } = issueSession("keyA", T0);
    expect(verifySession(token, T0)).toBe(true);
    _setSessionSecretForTest(Buffer.alloc(32, 9)); // different gateway secret
    expect(verifySession(token, T0)).toBe(false);
  });

  it("rejects an expired token", () => {
    const { token, exp } = issueSession("keyA", T0);
    expect(verifySession(token, exp + 1)).toBe(false);
  });

  it("rejects tampered payload", () => {
    const { token } = issueSession("keyA", T0);
    const [, sig] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ k: "keyB", exp: T0 + 1e9 })).toString("base64url")}.${sig}`;
    expect(verifySession(forged, T0)).toBe(false);
  });

  it("rejects malformed tokens", () => {
    expect(verifySession("nodot", T0)).toBe(false);
    expect(verifySession("", T0)).toBe(false);
    expect(verifySession(".onlysig", T0)).toBe(false);
  });
});

describe("challenges", () => {
  it("consumes a valid challenge exactly once", () => {
    const c = issueChallenge(T0);
    expect(consumeChallenge(c, T0 + 1000)).toBe(true);
    expect(consumeChallenge(c, T0 + 1000)).toBe(false); // already consumed
  });

  it("rejects an unknown challenge", () => {
    expect(consumeChallenge("never-issued", T0)).toBe(false);
  });

  it("rejects an expired challenge", () => {
    const c = issueChallenge(T0);
    expect(consumeChallenge(c, T0 + 10 * 60_000)).toBe(false); // past 5-min TTL
  });

  it("issues unique challenges", () => {
    const a = issueChallenge(T0);
    const b = issueChallenge(T0);
    expect(a).not.toBe(b);
  });
});
