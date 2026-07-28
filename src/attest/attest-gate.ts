/**
 * Shared App Attest gate decision — pure, no disk, no runtime.
 *
 * Three call sites enforce the same rule and used to hold three copies of it:
 *   - `src/http/server.ts`                   → the `/friday-next/*` prefix (auth: "plugin")
 *   - `src/http/handlers/session-delete.ts`  → `/friday-next-admin/sessions` (auth: "gateway")
 *   - `src/public-access/filter-proxy.ts`    → `/gateway` + `/__openclaw__/*`, which never reach
 *                                              plugin code at all (core owns those routes), so the
 *                                              proxy is the only interception point that exists.
 *
 * `verify` is injected rather than imported so this module stays free of `attest-store`'s
 * module-level state and disk IO, and so the tables below are testable on their own.
 */

export const ATTEST_HEADER = "x-fridaynext-attest";

/** Cookie carrying the same session token, for the ONE surface that cannot set headers:
 * the canvas WKWebView's sub-resources (JS/CSS/XHR the page itself issues — WebKit does not
 * propagate `URLRequest` headers from the top-level navigation to them). Accepted for
 * `/__openclaw__/*` only; every other surface is header-only, so a cookie can never stand in
 * as a credential for the REST API or the node WebSocket. */
export const ATTEST_COOKIE = "fn_attest";

export type HeaderBag = Record<string, string | string[] | undefined>;

export type AttestGateScope = "plugin" | "proxy";

function firstHeader(headers: HeaderBag, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Extract `name` from a `Cookie:` header value. First occurrence wins. */
export function cookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    const unquoted =
      raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw;
    return unquoted.length ? unquoted : null;
  }
  return null;
}

/** Session token presented by the caller, header first. */
export function attestTokenFromHeaders(headers: HeaderBag, allowCookie: boolean): string | null {
  const header = firstHeader(headers, ATTEST_HEADER);
  if (header && header.length) return header;
  if (!allowCookie) return null;
  return cookieValue(firstHeader(headers, "cookie"), ATTEST_COOKIE);
}

/** Paths exempt from the App Attest gate: the attest bootstrap itself, health, and
 * owner-side plugin/pairing management (Bearer-authed, used before/without an app
 * session). Everything else requires a valid session token when attest is on. */
export function isAttestExempt(pathname: string): boolean {
  return (
    pathname.startsWith("/friday-next/attest/") ||
    pathname === "/friday-next/health" ||
    pathname === "/friday-next/status" || // server-side install-script connectivity probe
    pathname === "/friday-next/plugin/info" ||
    // NOTE: plugin/upgrade is deliberately NOT exempt. It is called from the app's
    // connection page inside a normally-attested session — unlike pair/claim it has no
    // "must be reachable pre-token" necessity, and exempting it let a leaked bearer
    // trigger npm installs + gateway restarts from the public internet.
    pathname === "/friday-next/public-access/pairing" ||
    pathname === "/friday-next/pair/claim" // D12 voucher claim — pre-token, voucher IS the credential
  );
}

/** Which public-surface paths the FILTER PROXY must gate itself.
 *
 * Only the two core-owned surfaces. `/friday-next/*` and `/friday-next-admin/*` are deliberately
 * excluded: the plugin gates those downstream and owns the exemption table above — re-gating them
 * here would kill pairing (`/pair/claim`, `/attest/*` are pre-token by construction). */
export function requiresAttestAtProxy(pathname: string): boolean {
  return /^\/gateway(\/|$)/.test(pathname) || /^\/__openclaw__(\/|$)/.test(pathname);
}

/** Cookies are accepted for the canvas surface only — see ATTEST_COOKIE. */
export function attestCookieAllowedFor(pathname: string): boolean {
  return /^\/__openclaw__(\/|$)/.test(pathname);
}

export function attestGateDecision(args: {
  pathname: string;
  headers: HeaderBag;
  /** Request arrived via the relay (the proxy's unforgeable marker). LAN is never gated. */
  isPublic: boolean;
  /** Config switch: `appAttest.required` for the plugin scope, `gatePublicSurfaces` for the proxy. */
  required: boolean;
  scope: AttestGateScope;
  verify: (token: string) => boolean;
}): "allow" | "reject" {
  const { pathname, headers, isPublic, required, scope, verify } = args;
  if (!isPublic || !required) return "allow";
  if (scope === "plugin" ? isAttestExempt(pathname) : !requiresAttestAtProxy(pathname)) {
    return "allow";
  }
  const token = attestTokenFromHeaders(
    headers,
    scope === "proxy" && attestCookieAllowedFor(pathname),
  );
  if (!token) return "reject";
  // Fail CLOSED. `verifySession` itself does not throw, but it reads the session secret off disk
  // on first use. A broken install must not silently degrade into an ungated public face; a total
  // public-surface outage is loud and diagnosable, a bypass is neither.
  try {
    return verify(token) ? "allow" : "reject";
  } catch {
    return "reject";
  }
}

/** The single rejection shape all three call sites emit. */
export const ATTEST_REJECTION_BODY = {
  error: "app attestation required",
  code: "attest_required",
} as const;
