import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock only the runtime factory; keep the pure helpers (parseControlPlaneBackends,
// isValidSubdomainLabel, TunnelHealthTracker, ...) real so frpc-manager's re-exports stay valid.
vi.mock("@syengup/tunnel-edge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@syengup/tunnel-edge")>();
  return { ...actual, startTunnelRuntime: vi.fn() };
});

import { startTunnelRuntime } from "@syengup/tunnel-edge";
import type { TunnelRuntime, TunnelRuntimePairingInfo } from "@syengup/tunnel-edge";
import {
  buildTunnelBackends,
  currentServedSubdomains,
  getPairingInfo,
  reconcileServedSubdomains,
  startPublicAccess,
  stopPublicAccess,
  type PublicAccessConfig,
} from "./frpc-manager.js";
import { clearFridayNextRuntime, setFridayNextRuntime } from "../runtime.js";

const startTunnelRuntimeMock = vi.mocked(startTunnelRuntime);

const pairing: TunnelRuntimePairingInfo = {
  v: 2,
  lanUrl: "http://192.168.100.133:18789",
  publicUrl: "https://fnbase.bj.gw.syengup.host",
  fingerprint: "a".repeat(64),
  token: "auth",
  subdomain: "fnbase",
};

const baseCfg = {
  enabled: true,
  relayAddr: "relay.example:7000",
  relayToken: "token",
  subDomainHost: "bj.gw.syengup.host",
  subdomain: "fnbase",
  allocatorUrl: "https://gw.syengup.host/gw-alloc/allocate",
  certSignUrl: "https://gw.syengup.host/gw-alloc/sign-cert",
  controlPlaneUrl: "https://gw.syengup.host",
  corePort: 18789,
  edgeMode: "in-process",
  authToken: "auth",
} satisfies PublicAccessConfig;

function setGate(enabled: boolean): void {
  setFridayNextRuntime({
    config: {
      current: () => ({
        channels: {
          "friday-next": {
            logLevel: "info",
            publicAccess: { conductorPort: 0, conductorHost: "127.0.0.1" },
            appAttest: { gatePublicSurfaces: enabled },
          },
        },
      }),
    },
  });
}

function makeFakeRuntime(): TunnelRuntime {
  return {
    start: vi.fn<() => Promise<TunnelRuntimePairingInfo | null>>(),
    stop: vi.fn<() => void>(),
    reconcile: vi.fn<() => Promise<boolean>>(),
    pairingInfo: vi.fn<() => TunnelRuntimePairingInfo | null>(),
    servedSubdomains: vi.fn<() => string[]>(),
    status: vi.fn(),
  };
}

function installFakeRuntime(): TunnelRuntime {
  const fake = makeFakeRuntime();
  fake.start.mockResolvedValue(pairing);
  fake.pairingInfo.mockReturnValue(pairing);
  fake.servedSubdomains.mockReturnValue(["fnbase"]);
  startTunnelRuntimeMock.mockReturnValue(fake);
  return fake;
}

function installedHost() {
  const call = startTunnelRuntimeMock.mock.calls[0];
  if (!call) throw new Error("startTunnelRuntime was not called");
  return call[1];
}

const legacyDataDir =
  process.env.FRIDAY_NEXT_PUBLIC_ACCESS_DATA_DIR?.trim() ||
  join(homedir(), ".openclaw", "friday-next", "public-access");

beforeEach(() => {
  stopPublicAccess();
  startTunnelRuntimeMock.mockReset();
  setGate(true);
});

afterEach(() => {
  stopPublicAccess();
  clearFridayNextRuntime();
  vi.unstubAllGlobals();
});

describe("startPublicAccess (tunnel-runtime adapter)", () => {
  it("builds the shared-runtime config and delegates bring-up", async () => {
    const fake = installFakeRuntime();

    const out = await startPublicAccess(baseCfg, () => undefined);

    expect(out).toEqual(pairing);
    expect(startTunnelRuntimeMock).toHaveBeenCalledTimes(1);
    const config = startTunnelRuntimeMock.mock.calls[0]![0];
    expect(config.dataDir).toBe(legacyDataDir);
    expect(config.corePort).toBe(baseCfg.corePort);
    expect(config.authToken).toBe(baseCfg.authToken);
    expect(config.edgeMode).toBe("in-process");
    expect(config.edgeLogLevel).toBe("info");
    expect(config.subdomain).toBe("fnbase");
    expect(config.relayAddr).toBe("relay.example:7000");
    expect(config.relayToken).toBe("token");
    expect(config.lanUrl).toMatch(/^http:\/\/[^:]+:18789$/);
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(installedHost().buildBackends()).toEqual(buildTunnelBackends(baseCfg));
  });

  it("host.attestGate and externalAttestUrl read the live plugin config", async () => {
    installFakeRuntime();
    await startPublicAccess(baseCfg, () => undefined);
    const host = installedHost();

    const gate = host.attestGate();
    expect(gate.enabled()).toBe(true);
    expect(host.externalAttestUrl?.()).toBe(
      `http://127.0.0.1:${baseCfg.corePort}/friday-next/edge/verify-attest`,
    );
    expect(typeof gate.verify).toBe("function");

    setGate(false);
    expect(gate.enabled()).toBe(false);
    expect(host.externalAttestUrl?.()).toBeUndefined();
  });

  it("returns null and tears down when the config is hard-disabled", async () => {
    const fake = installFakeRuntime();
    await startPublicAccess(baseCfg, () => undefined);
    expect(startTunnelRuntimeMock).toHaveBeenCalledTimes(1);

    const out = await startPublicAccess({ ...baseCfg, enabled: false }, () => undefined);

    expect(out).toBeNull();
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(getPairingInfo()).toBeNull();
    expect(startTunnelRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it("is idempotent for an equivalent config and keeps the cached pairing", async () => {
    const fake = installFakeRuntime();
    await startPublicAccess(baseCfg, () => undefined);

    const second = await startPublicAccess({ ...baseCfg }, () => undefined);

    expect(second).toEqual(pairing);
    expect(startTunnelRuntimeMock).toHaveBeenCalledTimes(1);
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(fake.stop).not.toHaveBeenCalled();
  });

  it("rebuilds the runtime when a runtime-defining field changes", async () => {
    const first = installFakeRuntime();
    await startPublicAccess(baseCfg, () => undefined);

    const second = makeFakeRuntime();
    second.start.mockResolvedValue({ ...pairing, lanUrl: "http://192.168.100.133:18790" });
    second.pairingInfo.mockReturnValue({ ...pairing, lanUrl: "http://192.168.100.133:18790" });
    second.servedSubdomains.mockReturnValue(["fnbase"]);
    startTunnelRuntimeMock.mockReturnValue(second);

    const out = await startPublicAccess({ ...baseCfg, corePort: 18790 }, () => undefined);

    expect(out?.lanUrl).toContain(":18790");
    expect(startTunnelRuntimeMock).toHaveBeenCalledTimes(2);
    expect(first.stop).toHaveBeenCalledTimes(1);
  });
});

describe("delegation surface", () => {
  it("stopPublicAccess delegates to the runtime and clears adapter state", async () => {
    const fake = installFakeRuntime();
    await startPublicAccess(baseCfg, () => undefined);

    stopPublicAccess();

    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(getPairingInfo()).toBeNull();
    expect(currentServedSubdomains()).toEqual([]);
    expect(await reconcileServedSubdomains(baseCfg, ["fnbase"], () => undefined)).toBe(false);
  });

  it("reconcileServedSubdomains delegates the desired set and backends", async () => {
    const fake = installFakeRuntime();
    await startPublicAccess(baseCfg, () => undefined);
    const backends = buildTunnelBackends(baseCfg);
    fake.reconcile.mockResolvedValue(true);

    const changed = await reconcileServedSubdomains(
      baseCfg,
      ["fnbase", "fnalice"],
      () => undefined,
      backends,
    );

    expect(changed).toBe(true);
    expect(fake.reconcile).toHaveBeenCalledWith(["fnbase", "fnalice"], backends);
  });

  it("getPairingInfo and currentServedSubdomains delegate to the runtime", async () => {
    const fake = installFakeRuntime();
    await startPublicAccess(baseCfg, () => undefined);

    expect(getPairingInfo()).toEqual(pairing);
    expect(currentServedSubdomains()).toEqual(["fnbase"]);
    expect(fake.pairingInfo).toHaveBeenCalled();
    expect(fake.servedSubdomains).toHaveBeenCalled();
  });
});
