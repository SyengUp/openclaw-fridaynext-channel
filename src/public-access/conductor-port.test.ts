import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearFridayNextRuntime, setFridayNextRuntime } from "../runtime.js";
import { resolveConductorPort, type PublicAccessConfig } from "./frpc-manager.js";

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
          channels: { "friday-next": { publicAccess: { conductorPort: 24082 } } },
        }),
      },
    });
  });

  afterEach(() => {
    clearFridayNextRuntime();
    delete process.env.FRIDAY_NEXT_CONDUCTOR_PORT;
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
