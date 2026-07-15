import { describe, expect, it } from "vitest";
import {
  consumeChallenge,
  issueChallenge,
  issueSession,
  verifySession,
} from "./attest-store.js";

const T0 = 1_700_000_000_000;
const AUTH = "gateway-token-abc";

describe("session tokens", () => {
  it("issues a token that verifies with the same auth token", () => {
    const { token, exp } = issueSession("keyA", AUTH, T0);
    expect(exp).toBeGreaterThan(T0);
    expect(verifySession(token, AUTH, T0)).toBe(true);
  });

  it("rejects a token signed with a different auth token (HMAC mismatch)", () => {
    const { token } = issueSession("keyA", AUTH, T0);
    expect(verifySession(token, "other-token", T0)).toBe(false);
  });

  it("rejects an expired token", () => {
    const { token, exp } = issueSession("keyA", AUTH, T0);
    expect(verifySession(token, AUTH, exp + 1)).toBe(false);
  });

  it("rejects tampered payload", () => {
    const { token } = issueSession("keyA", AUTH, T0);
    const [, sig] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ k: "keyB", exp: T0 + 1e9 })).toString("base64url")}.${sig}`;
    expect(verifySession(forged, AUTH, T0)).toBe(false);
  });

  it("rejects malformed tokens", () => {
    expect(verifySession("nodot", AUTH, T0)).toBe(false);
    expect(verifySession("", AUTH, T0)).toBe(false);
    expect(verifySession(".onlysig", AUTH, T0)).toBe(false);
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
