import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  default: { lookup: vi.fn() },
}));

import dns from "node:dns/promises";
import {
  BlockedUrlError,
  assertPublicHttpUrl,
  assertResolvesPublic,
  fetchPublicUrl,
  isPrivateAddress,
  parseHttpUrl,
} from "./ssrf-guard.js";

const lookupMock = vi.mocked(dns.lookup);

function mockPublicDns(): void {
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
}

beforeEach(() => {
  lookupMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseHttpUrl", () => {
  it("accepts absolute http/https URLs", () => {
    expect(parseHttpUrl("https://example.com/a?b=1")?.hostname).toBe("example.com");
    expect(parseHttpUrl("  http://example.com  ")?.protocol).toBe("http:");
  });

  it("rejects non-http schemes and garbage", () => {
    expect(parseHttpUrl("ftp://example.com/a")).toBeNull();
    expect(parseHttpUrl("file:///etc/passwd")).toBeNull();
    expect(parseHttpUrl("javascript:alert(1)")).toBeNull();
    expect(parseHttpUrl("not a url")).toBeNull();
    expect(parseHttpUrl("/relative/path")).toBeNull();
  });
});

describe("assertPublicHttpUrl", () => {
  it("rejects non-default ports", () => {
    expect(() => assertPublicHttpUrl(new URL("http://example.com:8080/"))).toThrow(BlockedUrlError);
    expect(() => assertPublicHttpUrl(new URL("https://example.com:8443/"))).toThrow(BlockedUrlError);
  });

  it("allows default and explicit 80/443 ports", () => {
    expect(() => assertPublicHttpUrl(new URL("https://example.com/"))).not.toThrow();
    expect(() => assertPublicHttpUrl(new URL("http://example.com:80/"))).not.toThrow();
    expect(() => assertPublicHttpUrl(new URL("https://example.com:443/"))).not.toThrow();
  });

  it("rejects localhost and internal-suffix hostnames", () => {
    expect(() => assertPublicHttpUrl(new URL("http://localhost/"))).toThrow(BlockedUrlError);
    expect(() => assertPublicHttpUrl(new URL("http://gateway.local/"))).toThrow(BlockedUrlError);
    expect(() => assertPublicHttpUrl(new URL("http://db.internal/"))).toThrow(BlockedUrlError);
    expect(() => assertPublicHttpUrl(new URL("http://nas.home.arpa/"))).toThrow(BlockedUrlError);
  });

  it("rejects private IP literals including bracketed IPv6", () => {
    expect(() => assertPublicHttpUrl(new URL("http://127.0.0.1/"))).toThrow(BlockedUrlError);
    expect(() => assertPublicHttpUrl(new URL("http://10.0.0.5/"))).toThrow(BlockedUrlError);
    expect(() => assertPublicHttpUrl(new URL("http://[::1]/"))).toThrow(BlockedUrlError);
    expect(() => assertPublicHttpUrl(new URL("http://[fc00::1]/"))).toThrow(BlockedUrlError);
  });

  it("allows public IP literals", () => {
    expect(() => assertPublicHttpUrl(new URL("http://93.184.216.34/"))).not.toThrow();
  });
});

describe("isPrivateAddress", () => {
  it("flags private/reserved IPv4 ranges", () => {
    for (const ip of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "100.127.255.255",
      "127.0.0.1",
      "169.254.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.168.1.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("passes public IPv4", () => {
    for (const ip of ["8.8.8.8", "93.184.216.34", "100.63.0.1", "100.128.0.1", "172.32.0.1", "198.20.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("passes 198.18/15 (fake-IP DNS range used by clash/surge tun mode)", () => {
    expect(isPrivateAddress("198.18.1.156")).toBe(false);
    expect(isPrivateAddress("198.19.255.255")).toBe(false);
  });

  it("flags private/reserved IPv6 and mapped IPv4", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("passes public IPv6 and mapped public IPv4", () => {
    expect(isPrivateAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
    expect(isPrivateAddress("::ffff:93.184.216.34")).toBe(false);
  });

  it("treats non-IP strings as unsafe", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

describe("assertResolvesPublic", () => {
  it("passes when all resolved addresses are public", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ] as never);
    await expect(assertResolvesPublic(new URL("https://example.com/"))).resolves.toBeUndefined();
  });

  it("throws BlockedUrlError when any resolved address is private", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ] as never);
    await expect(assertResolvesPublic(new URL("https://rebind.example.com/"))).rejects.toThrow(BlockedUrlError);
  });

  it("validates IP-literal hosts without a DNS lookup", async () => {
    await expect(assertResolvesPublic(new URL("http://127.0.0.1/"))).rejects.toThrow(BlockedUrlError);
    await expect(assertResolvesPublic(new URL("http://93.184.216.34/"))).resolves.toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("throws a plain error (not BlockedUrlError) on DNS failure", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    const err = await assertResolvesPublic(new URL("https://nope.example.com/")).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BlockedUrlError);
  });
});

describe("fetchPublicUrl", () => {
  const opts = { maxBytes: 1024, timeoutMs: 5000 };

  it("fetches a public URL and returns body + finalUrl", async () => {
    mockPublicDns();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>hi</html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })),
    );
    const result = await fetchPublicUrl("https://example.com/page", opts);
    expect(result?.finalUrl).toBe("https://example.com/page");
    expect(result?.contentType).toContain("text/html");
    expect(result?.body.toString()).toBe("<html>hi</html>");
  });

  it("follows redirects and re-validates each hop", async () => {
    mockPublicDns();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://other.example.com/final" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200, headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchPublicUrl("https://example.com/start", opts);
    expect(result?.finalUrl).toBe("https://other.example.com/final");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lookupMock).toHaveBeenCalledTimes(2);
  });

  it("throws BlockedUrlError when a redirect targets a private address", async () => {
    mockPublicDns();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } })),
    );
    await expect(fetchPublicUrl("https://example.com/start", opts)).rejects.toThrow(BlockedUrlError);
  });

  it("throws BlockedUrlError for a directly-blocked URL", async () => {
    await expect(fetchPublicUrl("http://192.168.1.1/", opts)).rejects.toThrow(BlockedUrlError);
  });

  it("returns null when the body exceeds maxBytes (ignoring content-length)", async () => {
    mockPublicDns();
    const big = "x".repeat(2048);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(big, { status: 200, headers: { "content-type": "text/html", "content-length": "10" } })),
    );
    expect(await fetchPublicUrl("https://example.com/big", opts)).toBeNull();
  });

  it("returns null when content-type does not match the required prefixes", async () => {
    mockPublicDns();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
    );
    expect(
      await fetchPublicUrl("https://example.com/api", { ...opts, requireContentTypePrefixes: ["text/html", "application/xhtml+xml"] }),
    ).toBeNull();
  });

  it("returns null on non-2xx and on DNS failure", async () => {
    mockPublicDns();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    expect(await fetchPublicUrl("https://example.com/missing", opts)).toBeNull();

    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    expect(await fetchPublicUrl("https://nope.example.com/", opts)).toBeNull();
  });

  it("gives up after too many redirects", async () => {
    mockPublicDns();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://example.com/loop" } })),
    );
    expect(await fetchPublicUrl("https://example.com/loop", opts)).toBeNull();
  });
});
