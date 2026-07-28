import { describe, expect, it } from "vitest";

import {
  ATTEST_COOKIE,
  ATTEST_HEADER,
  attestGateDecision,
  attestTokenFromHeaders,
  isAttestExempt,
  requiresAttestAtProxy,
} from "./attest-gate.js";

describe("attestTokenFromHeaders", () => {
  it("reads the header", () => {
    expect(attestTokenFromHeaders({ [ATTEST_HEADER]: "tok" }, false)).toBe("tok");
  });

  it("collapses an array-valued header to the first entry", () => {
    expect(attestTokenFromHeaders({ [ATTEST_HEADER]: ["a", "b"] }, false)).toBe("a");
  });

  it("falls back to the cookie when no header is present", () => {
    expect(attestTokenFromHeaders({ cookie: `${ATTEST_COOKIE}=tok` }, true)).toBe("tok");
  });

  it("picks the right cookie out of several", () => {
    const cookie = `other=1; ${ATTEST_COOKIE}=tok; trailing=2`;
    expect(attestTokenFromHeaders({ cookie }, true)).toBe("tok");
  });

  it("tolerates whitespace and a trailing semicolon", () => {
    expect(attestTokenFromHeaders({ cookie: `  ${ATTEST_COOKIE} = tok ;` }, true)).toBe("tok");
  });

  it("does not match a cookie whose name merely ends with the attest name", () => {
    expect(attestTokenFromHeaders({ cookie: `x_${ATTEST_COOKIE}=nope` }, true)).toBeNull();
  });

  it("prefers the header over the cookie", () => {
    const headers = { [ATTEST_HEADER]: "fromHeader", cookie: `${ATTEST_COOKIE}=fromCookie` };
    expect(attestTokenFromHeaders(headers, true)).toBe("fromHeader");
  });

  it("returns null for absent, empty, and malformed values", () => {
    expect(attestTokenFromHeaders({}, true)).toBeNull();
    expect(attestTokenFromHeaders({ [ATTEST_HEADER]: "" }, true)).toBeNull();
    expect(attestTokenFromHeaders({ cookie: `${ATTEST_COOKIE}=` }, true)).toBeNull();
    expect(attestTokenFromHeaders({ cookie: "malformed" }, true)).toBeNull();
  });
});

describe("isAttestExempt", () => {
  // These are the pre-token bootstrap endpoints: gating them would deadlock pairing, since a
  // device cannot obtain a session token without reaching them first.
  it.each([
    "/friday-next/attest/challenge",
    "/friday-next/attest/verify",
    "/friday-next/attest/refresh",
    "/friday-next/health",
    "/friday-next/status",
    "/friday-next/plugin/info",
    "/friday-next/public-access/pairing",
    "/friday-next/pair/claim",
  ])("exempts %s", (p) => {
    expect(isAttestExempt(p)).toBe(true);
  });

  it.each([
    "/friday-next/messages",
    "/friday-next/events",
    "/friday-next/files/abc",
    "/friday-next/plugin/upgrade", // deliberately gated — it mutates the gateway
    "/friday-next/attest", // the prefix rule needs the trailing slash
    "/friday-next/healthz", // exact match only
  ])("does not exempt %s", (p) => {
    expect(isAttestExempt(p)).toBe(false);
  });
});

describe("requiresAttestAtProxy", () => {
  it.each([
    "/gateway",
    "/gateway/",
    "/gateway/sub",
    "/__openclaw__/a2ui/",
    "/__openclaw__/canvas/x.js",
  ])("gates %s at the proxy", (p) => {
    expect(requiresAttestAtProxy(p)).toBe(true);
  });

  // The plugin's own gate owns these, exemption table included. Double-gating at the proxy would
  // reject the bootstrap endpoints and deadlock pairing.
  it.each([
    "/friday-next/messages",
    "/friday-next/attest/challenge",
    "/friday-next/pair/claim",
    "/friday-next-admin/sessions",
  ])("leaves %s to the plugin gate", (p) => {
    expect(requiresAttestAtProxy(p)).toBe(false);
  });

  it("does not gate paths that merely share a prefix", () => {
    expect(requiresAttestAtProxy("/gatewayx")).toBe(false);
    expect(requiresAttestAtProxy("/__openclaw__x")).toBe(false);
  });
});

describe("attestGateDecision", () => {
  const verifyOk = (t: string) => t === "good";

  it("allows when the gate is not required", () => {
    const d = attestGateDecision({
      pathname: "/friday-next/messages",
      isPublic: true,
      required: false,
      verify: verifyOk,
      scope: "plugin" as const,
      headers: {},
    });
    expect(d).toBe("allow");
  });

  it("allows LAN requests without a token", () => {
    const d = attestGateDecision({
      pathname: "/friday-next/messages",
      isPublic: false,
      required: true,
      verify: verifyOk,
      scope: "plugin" as const,
      headers: {},
    });
    expect(d).toBe("allow");
  });

  it("allows an exempt path on the public surface without a token", () => {
    const d = attestGateDecision({
      pathname: "/friday-next/attest/challenge",
      isPublic: true,
      required: true,
      verify: verifyOk,
      scope: "plugin" as const,
      headers: {},
    });
    expect(d).toBe("allow");
  });

  it("rejects a gated public path with no token", () => {
    const d = attestGateDecision({
      pathname: "/friday-next/messages",
      isPublic: true,
      required: true,
      verify: verifyOk,
      scope: "plugin" as const,
      headers: {},
    });
    expect(d).toBe("reject");
  });

  it("rejects a token that fails verification", () => {
    const d = attestGateDecision({
      pathname: "/friday-next/messages",
      isPublic: true,
      required: true,
      verify: verifyOk,
      scope: "plugin" as const,
      headers: { [ATTEST_HEADER]: "bad" },
    });
    expect(d).toBe("reject");
  });

  it("allows a verified token", () => {
    const d = attestGateDecision({
      pathname: "/friday-next/messages",
      isPublic: true,
      required: true,
      verify: verifyOk,
      scope: "plugin" as const,
      headers: { [ATTEST_HEADER]: "good" },
    });
    expect(d).toBe("allow");
  });

  it("accepts a cookie-borne token — the canvas sub-resource path", () => {
    const d = attestGateDecision({
      pathname: "/__openclaw__/canvas/app.js",
      isPublic: true,
      required: true,
      verify: verifyOk,
      scope: "proxy" as const,
      headers: { cookie: `${ATTEST_COOKIE}=good` },
    });
    expect(d).toBe("allow");
  });

  it("treats a throwing verifier as a rejection", () => {
    const d = attestGateDecision({
      pathname: "/friday-next/messages",
      isPublic: true,
      required: true,
      verify: () => {
        throw new Error("boom");
      },
      scope: "plugin" as const,
      headers: { [ATTEST_HEADER]: "good" },
    });
    expect(d).toBe("reject");
  });
});
