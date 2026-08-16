import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHINA_NPM_MIRROR,
  OFFICIAL_NPM_REGISTRY,
  alternateRegistry,
  npmRegistryEnv,
  resetNpmRegistryCacheForTest,
  resolveNpmRegistry,
} from "./npm-registry.js";

const officialPing = "https://registry.npmjs.org/-/ping";
const mirrorPing = "https://registry.npmmirror.com/-/ping";

let fetchMock: ReturnType<typeof vi.fn>;
/** url → latency ms; null = unreachable (non-2xx). */
let pingResults: Record<string, number | null>;

function installFetchMock() {
  fetchMock = vi.fn(async (input: string) => {
    const latency = pingResults[input];
    if (latency === undefined || latency === null) {
      return new Response("nope", { status: 500 });
    }
    await new Promise((resolve) => setTimeout(resolve, latency));
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
}

describe("npm-registry", () => {
  beforeEach(() => {
    resetNpmRegistryCacheForTest();
    delete process.env.FRIDAY_NPM_REGISTRY;
    pingResults = {};
    installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FRIDAY_NPM_REGISTRY;
  });

  it("chooses the official registry when it is faster, and leaves npm env unset", async () => {
    pingResults[officialPing] = 100;
    pingResults[mirrorPing] = 200;
    expect(await resolveNpmRegistry(1000)).toBe(OFFICIAL_NPM_REGISTRY);
    expect(await npmRegistryEnv(1000)).toBeUndefined();
  });

  it("chooses the China mirror when it is clearly faster than the official", async () => {
    pingResults[officialPing] = 800;
    pingResults[mirrorPing] = 70;
    expect(await resolveNpmRegistry(1000)).toBe(CHINA_NPM_MIRROR);
    expect(await npmRegistryEnv(1000)).toEqual({ npm_config_registry: CHINA_NPM_MIRROR });
  });

  it("prefers the official registry in a close race (delta within the equality window)", async () => {
    pingResults[officialPing] = 200;
    pingResults[mirrorPing] = 100; // 100ms faster — within the 150ms equality window
    expect(await resolveNpmRegistry(1000)).toBe(OFFICIAL_NPM_REGISTRY);
  });

  it("falls back to the China mirror when official is unreachable", async () => {
    pingResults[mirrorPing] = 100;
    expect(await resolveNpmRegistry(1000)).toBe(CHINA_NPM_MIRROR);
    expect(await npmRegistryEnv(1000)).toEqual({ npm_config_registry: CHINA_NPM_MIRROR });
  });

  it("returns official (and no env) when no registry responds", async () => {
    expect(await resolveNpmRegistry(1000)).toBe(OFFICIAL_NPM_REGISTRY);
    expect(await npmRegistryEnv(1000)).toBeUndefined();
  });

  it("honors the FRIDAY_NPM_REGISTRY env override without probing", async () => {
    process.env.FRIDAY_NPM_REGISTRY = "https://registry.custom.example/";
    expect(await resolveNpmRegistry(1000)).toBe("https://registry.custom.example/");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await npmRegistryEnv(1000)).toEqual({
      npm_config_registry: "https://registry.custom.example/",
    });
  });

  it("caches the resolved registry within the TTL (single parallel probe)", async () => {
    pingResults[officialPing] = 100;
    pingResults[mirrorPing] = 50;
    await resolveNpmRegistry(1000);
    await resolveNpmRegistry(1000 + 1000);
    // One probe = one fetch per candidate, in parallel.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-probes after the TTL expires", async () => {
    pingResults[officialPing] = 100;
    pingResults[mirrorPing] = 50;
    await resolveNpmRegistry(1000);
    await resolveNpmRegistry(1000 + 10 * 60_000 + 1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  describe("alternateRegistry", () => {
    it("returns the other known candidate", () => {
      expect(alternateRegistry(OFFICIAL_NPM_REGISTRY)).toBe(CHINA_NPM_MIRROR);
      expect(alternateRegistry(CHINA_NPM_MIRROR)).toBe(OFFICIAL_NPM_REGISTRY);
    });

    it("returns undefined for unknown registries (explicit override is authoritative)", () => {
      expect(alternateRegistry("https://registry.custom.example/")).toBeUndefined();
    });
  });

  describe("npmRegistryEnv(forcedRegistry)", () => {
    it("injects the forced mirror registry", async () => {
      expect(await npmRegistryEnv(1000, CHINA_NPM_MIRROR)).toEqual({
        npm_config_registry: CHINA_NPM_MIRROR,
      });
    });

    it("leaves env unset for the forced official registry", async () => {
      expect(await npmRegistryEnv(1000, OFFICIAL_NPM_REGISTRY)).toBeUndefined();
    });
  });
});
