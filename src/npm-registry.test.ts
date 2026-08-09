import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHINA_NPM_MIRROR,
  OFFICIAL_NPM_REGISTRY,
  npmRegistryEnv,
  resetNpmRegistryCacheForTest,
  resolveNpmRegistry,
} from "./npm-registry.js";

const officialPing = "https://registry.npmjs.org/-/ping";
const mirrorPing = "https://registry.npmmirror.com/-/ping";

let fetchMock: ReturnType<typeof vi.fn>;
let pingResults: Record<string, boolean>;

function installFetchMock() {
  fetchMock = vi.fn(async (input: string) => {
    const ok = pingResults[input] ?? false;
    return new Response(ok ? "{}" : "nope", { status: ok ? 200 : 500 });
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

  it("uses the official registry when it responds, and leaves npm env unset", async () => {
    pingResults[officialPing] = true;
    expect(await resolveNpmRegistry(1000)).toBe(OFFICIAL_NPM_REGISTRY);
    expect(await npmRegistryEnv(1000)).toBeUndefined();
  });

  it("falls back to the China mirror when official is unreachable", async () => {
    pingResults[mirrorPing] = true;
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

  it("caches the resolved registry within the TTL (single probe)", async () => {
    pingResults[officialPing] = true;
    await resolveNpmRegistry(1000);
    await resolveNpmRegistry(1000 + 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-probes after the TTL expires", async () => {
    pingResults[officialPing] = true;
    await resolveNpmRegistry(1000);
    await resolveNpmRegistry(1000 + 10 * 60_000 + 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
