import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearFridayNextRuntime, setFridayNextRuntime } from "../runtime.js";
import {
  resolveConductorHost,
  resolveConductorPort,
  type PublicAccessConfig,
} from "./frpc-manager.js";

const baseConfig = {
  enabled: true,
  relayAddr: "relay.example:7000",
  relayToken: "token",
  subDomainHost: "bj.gw.syengup.host",
  allocatorUrl: "https://gw.syengup.host/gw-alloc/allocate",
  certSignUrl: "https://gw.syengup.host/gw-alloc/sign-cert",
  controlPlaneUrl: "https://gw.syengup.host",
  corePort: 18789,
  authToken: "auth",
} satisfies PublicAccessConfig;

describe("resolveConductorPort", () => {
  beforeEach(() => {
    setFridayNextRuntime({
      config: {
        current: () => ({
          channels: {
            "friday-next": {
              publicAccess: { conductorPort: 24082, conductorHost: "192.168.100.124" },
            },
          },
        }),
      },
    });
  });

  afterEach(() => {
    clearFridayNextRuntime();
    delete process.env.FRIDAY_NEXT_CONDUCTOR_PORT;
    delete process.env.FRIDAY_NEXT_CONDUCTOR_HOST;
  });

  it("prefers an explicit PublicAccessConfig.conductorPort", () => {
    process.env.FRIDAY_NEXT_CONDUCTOR_PORT = "24081";
    expect(resolveConductorPort({ ...baseConfig, conductorPort: 24080 })).toBe(24080);
  });

  it("falls back to FRIDAY_NEXT_CONDUCTOR_PORT (positive integer)", () => {
    process.env.FRIDAY_NEXT_CONDUCTOR_PORT = "24081";
    expect(resolveConductorPort({ ...baseConfig })).toBe(24081);
  });

  it("falls back to plugin runtime config when env is absent", () => {
    expect(resolveConductorPort({ ...baseConfig })).toBe(24082);
  });

  it("treats 0 as disabled and keeps falling through", () => {
    process.env.FRIDAY_NEXT_CONDUCTOR_PORT = "0";
    expect(resolveConductorPort({ ...baseConfig })).toBe(24082);
  });
});

describe("resolveConductorHost", () => {
  beforeEach(() => {
    setFridayNextRuntime({
      config: {
        current: () => ({
          channels: {
            "friday-next": {
              publicAccess: { conductorPort: 24082, conductorHost: "192.168.100.124" },
            },
          },
        }),
      },
    });
  });

  afterEach(() => {
    clearFridayNextRuntime();
    delete process.env.FRIDAY_NEXT_CONDUCTOR_HOST;
  });

  it("prefers an explicit PublicAccessConfig.conductorHost", () => {
    process.env.FRIDAY_NEXT_CONDUCTOR_HOST = "192.168.100.133";
    expect(resolveConductorHost({ ...baseConfig, conductorHost: "192.168.100.125" })).toBe(
      "192.168.100.125",
    );
  });

  it("falls back to FRIDAY_NEXT_CONDUCTOR_HOST", () => {
    process.env.FRIDAY_NEXT_CONDUCTOR_HOST = "192.168.100.133";
    expect(resolveConductorHost({ ...baseConfig })).toBe("192.168.100.133");
  });

  it("falls back to plugin runtime config and rejects malformed values", () => {
    expect(resolveConductorHost({ ...baseConfig })).toBe("192.168.100.124");
    expect(resolveConductorHost({ ...baseConfig, conductorHost: "http://evil/x" })).toBe(
      "192.168.100.124",
    );
  });

  it("defaults to 127.0.0.1 with no source", () => {
    setFridayNextRuntime({
      config: { current: () => ({ channels: { "friday-next": { publicAccess: {} } } }) },
    });
    expect(resolveConductorHost({ ...baseConfig })).toBe("127.0.0.1");
  });
});
