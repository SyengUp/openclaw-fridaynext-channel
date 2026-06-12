/**
 * SSRF guard + restricted fetch for the link-preview endpoint.
 *
 * Unlike `downloadRemoteMedia` (agent-supplied URLs for outbound media), link-preview fetches
 * URLs that originate from arbitrary message text, so every hop must be validated: protocol,
 * port, hostname literals, and the full set of DNS-resolved addresses. Redirects are followed
 * manually so each target is re-checked before the next request.
 *
 * Known residual risk: DNS rebinding TOCTOU — we validate resolved addresses, then `fetch`
 * resolves again. Closing that gap requires dialing by IP with SNI/Host rewriting, which is
 * disproportionate for preview metadata; accepted at this threat level.
 */

import dns from "node:dns/promises";
import net from "node:net";

const MAX_REDIRECTS = 5;

export class BlockedUrlError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Blocked URL: ${reason}`);
    this.name = "BlockedUrlError";
    this.reason = reason;
  }
}

/** Parse an absolute http/https URL. Returns null for anything else (caller maps to invalid_url). */
export function parseHttpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url;
}

const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".home.arpa", ".localhost"];

/** Synchronous literal checks: port, hostname blocklist, IP-literal hosts. Throws BlockedUrlError. */
export function assertPublicHttpUrl(url: URL): void {
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new BlockedUrlError(`port ${url.port} not allowed`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new BlockedUrlError("empty host");
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new BlockedUrlError(`host "${host}" is not public`);
  }
  // IPv6 literal in a URL comes bracketed: strip for net.isIP.
  const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (net.isIP(bareHost) && isPrivateAddress(bareHost)) {
    throw new BlockedUrlError(`address ${bareHost} is private/reserved`);
  }
}

/** True when the IP (v4 or v6, including ::ffff: mapped v4) is private, loopback, or reserved. */
export function isPrivateAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true; // not an IP at all — treat as unsafe
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0/24
  if (a === 192 && b === 168) return true; // 192.168/16
  // 198.18/15 (benchmarking) intentionally NOT blocked: fake-IP DNS setups (clash/surge tun
  // mode, common on gateway hosts) resolve EVERY domain into this range, so blocking it kills
  // all lookups. The range is not used for real LAN services, so the SSRF exposure is nil.
  if (a >= 224) return true; // multicast 224/4 + reserved 240/4 + broadcast
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // ::ffff:a.b.c.d mapped IPv4 → validate the embedded v4.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (lower === "::" || lower === "::1") return true; // unspecified / loopback
  const head = lower.split(":")[0];
  // fc00::/8 (the reserved, never-assigned half of ULA fc00::/7) intentionally NOT blocked:
  // RFC 4193 requires locally-assigned ULA to set the L bit, so real LAN services live in
  // fd00::/8, while fake-IP DNS setups (mihomo/clash tun mode with IPv6, common on gateway
  // hosts) resolve EVERY domain into fc00::/18. Same rationale as 198.18/15 on the IPv4 side.
  if (head.startsWith("fd")) return true; // fd00::/8 locally-assigned ULA
  if (/^fe[89ab]/.test(head)) return true; // fe80::/10 link-local
  return false;
}

/** Resolve the hostname and require every returned address to be public. Throws BlockedUrlError. */
export async function assertResolvesPublic(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new BlockedUrlError(`address ${host} is private/reserved`);
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`DNS lookup failed for ${host}`);
  }
  if (!addresses.length) throw new Error(`DNS lookup returned no addresses for ${host}`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new BlockedUrlError(`${host} resolves to private/reserved address ${address}`);
    }
  }
}

export interface FetchPublicUrlOptions {
  maxBytes: number;
  timeoutMs: number;
  /** Sent as the Accept header. */
  accept?: string;
  /** When set, the response Content-Type must start with one of these prefixes. */
  requireContentTypePrefixes?: string[];
}

export interface FetchPublicUrlResult {
  finalUrl: string;
  contentType: string;
  body: Buffer;
}

const PREVIEW_USER_AGENT = "Mozilla/5.0 (compatible; OpenClawLinkPreview/1.0)";

/**
 * Fetch a public http/https URL with manual redirects (≤5 hops, each hop re-validated) and a
 * streamed size cap (Content-Length is not trusted). Returns null on ordinary failures (non-2xx,
 * oversize, timeout, bad content type, DNS error); throws BlockedUrlError on SSRF rejection.
 */
export async function fetchPublicUrl(
  rawUrl: string,
  opts: FetchPublicUrlOptions,
): Promise<FetchPublicUrlResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let current = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const url = parseHttpUrl(current);
      if (!url) return null;
      assertPublicHttpUrl(url);
      await assertResolvesPublic(url);

      const res = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": PREVIEW_USER_AGENT,
          ...(opts.accept ? { Accept: opts.accept } : {}),
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!location) return null;
        try {
          current = new URL(location, url).toString();
        } catch {
          return null;
        }
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return null;
      }

      const contentType = res.headers.get("content-type")?.trim().toLowerCase() ?? "";
      if (
        opts.requireContentTypePrefixes &&
        !opts.requireContentTypePrefixes.some((p) => contentType.startsWith(p))
      ) {
        await res.body?.cancel().catch(() => {});
        return null;
      }

      const body = await readBodyCapped(res, opts.maxBytes);
      if (body === null) return null;
      return { finalUrl: url.toString(), contentType, body };
    }
    return null; // too many redirects
  } catch (err) {
    if (err instanceof BlockedUrlError) throw err;
    return null; // timeout / network / DNS failure
  } finally {
    clearTimeout(timer);
  }
}

/** Stream the response body, aborting once it exceeds maxBytes. */
async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  if (!res.body) {
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.length <= maxBytes ? buffer : null;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(Buffer.from(value));
      }
    }
  } catch {
    return null;
  }
  const buffer = Buffer.concat(chunks);
  return buffer.length ? buffer : null;
}
