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

  it("returns null with no credentials and no cache — bring-up must block, not spawn frpc", async () => {
    stubFetch(() => ({ ok: false, status: 503 }));
    expect(await resolveRelayCredentials(baseCfg, log)).toBeNull();
  });

  it("rejects an incomplete payload rather than writing half-credentials", async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ relayAddr: "a:7000" }) }));
    expect(await resolveRelayCredentials(baseCfg, log)).toBeNull();
  });
});
