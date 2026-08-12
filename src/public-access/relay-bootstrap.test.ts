import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRelayCredentials } from "./frpc-manager.js";

// The relay address + shared frps token are deployment facts, so they are no longer written
// into every user's openclaw.json — the gateway resolves them at bring-up. These tests pin the
// precedence (config override > control plane > disk cache) and the fail-closed behaviour.

const DATA_DIR =
  process.env.FRIDAY_NEXT_PUBLIC_ACCESS_DATA_DIR?.trim() ||
  join(homedir(), ".openclaw", "friday-next", "public-access");
const CACHE = join(DATA_DIR, "relay-bootstrap.json");

const baseCfg = {
  enabled: true,
  relayAddr: "",
  relayToken: "",
  subDomainHost: "bj.gw.syengup.host",
  subdomain: "",
  allocatorUrl: "https://cp.test/gw-alloc/allocate",
  certSignUrl: "https://cp.test/gw-alloc/sign-cert",
  corePort: 18789,
  controlPlaneUrl: "https://cp.test",
  authToken: "gateway-bearer",
} as unknown as Parameters<typeof resolveRelayCredentials>[0];

const log = () => undefined;
let cacheBackup: string | null = null;

beforeEach(() => {
  try {
    cacheBackup = readFileSync(CACHE, "utf8");
  } catch {
    cacheBackup = null;
  }
  rmSync(CACHE, { force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(CACHE, { force: true });
  if (cacheBackup !== null) writeFileSync(CACHE, cacheBackup);
});

function stubFetch(impl: () => unknown) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

describe("relay credential resolution", () => {
  it("an explicit config override wins and never calls the control plane", async () => {
    const spy = vi.fn();
    stubFetch(spy);
    const cfg = { ...baseCfg, relayAddr: "my.frps:7000", relayToken: "my-token" };
    const out = await resolveRelayCredentials(cfg, log);
    expect(out?.relayToken).toBe("my-token");
    expect(out?.relayAddr).toBe("my.frps:7000");
    expect(spy).not.toHaveBeenCalled();
  });

  it("fetches from the control plane when config leaves them empty", async () => {
    stubFetch(() => ({
      ok: true,
      json: async () => ({ relayAddr: "47.95.195.236:7000", relayToken: "shared-token" }),
    }));
    const out = await resolveRelayCredentials(baseCfg, log);
    expect(out?.relayAddr).toBe("47.95.195.236:7000");
    expect(out?.relayToken).toBe("shared-token");
  });

  /// A control-plane outage must not take down a tunnel that already worked.
  it("falls back to the disk cache when the control plane is unreachable", async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ relayAddr: "a:7000", relayToken: "t1" }) }));
    await resolveRelayCredentials(baseCfg, log); // seeds the cache

    stubFetch(() => {
      throw new Error("network down");
    });
    const out = await resolveRelayCredentials(baseCfg, log);
    expect(out?.relayToken).toBe("t1");
  });

  /// North-America routing: the control plane returns the region's frps addr + subDomainHost
  /// and the plugin must adopt BOTH — a tunnel pointed at the NA frps but named under
  /// *.bj.gw would be unreachable (DNS has no such host, and the NA frps gate only knows *.na.gw).
  it("adopts subDomainHost + region from the control-plane bootstrap (NA routing)", async () => {
    stubFetch(() => ({
      ok: true,
      json: async () => ({
        relayAddr: "45.76.65.243:7000",
        relayToken: "shared-token",
        subDomainHost: "na.gw.syengup.host",
        region: "na",
      }),
    }));
    const out = await resolveRelayCredentials(baseCfg, log);
    expect(out?.relayAddr).toBe("45.76.65.243:7000");
    expect(out?.subDomainHost).toBe("na.gw.syengup.host");
    expect(out?.region).toBe("na");
  });

  /// An old control plane that predates multi-region returns no subDomainHost: the plugin must
  /// keep its config default (BJ), never fabricate an empty host.
  it("keeps the config subDomainHost when bootstrap omits it (old control plane)", async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ relayAddr: "b:7000", relayToken: "t2" }) }));
    const out = await resolveRelayCredentials(baseCfg, log);
    expect(out?.subDomainHost).toBe("bj.gw.syengup.host");
    expect(out?.region).toBeUndefined();
  });

  it("returns null with no credentials and no cache — bring-up must block, not spawn frpc", async () => {
    stubFetch(() => ({ ok: false, status: 503 }));
    expect(await resolveRelayCredentials(baseCfg, log)).toBeNull();
  });

  it("rejects an incomplete payload rather than writing half-credentials", async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ relayAddr: "a:7000" }) }));
    expect(await resolveRelayCredentials(baseCfg, log)).toBeNull();
  });
});
