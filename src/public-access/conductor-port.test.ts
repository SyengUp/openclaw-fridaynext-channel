import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearFridayNextRuntime, setFridayNextRuntime } from "../runtime.js";
import {
  buildTunnelBackends,
  edgeConfigFor,
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

describe("buildTunnelBackends", () => {
  beforeEach(() => {
    setFridayNextRuntime({
      config: { current: () => ({ channels: { "friday-next": { publicAccess: {} } } }) },
    });
  });

  afterEach(() => {
    clearFridayNextRuntime();
    delete process.env.FRIDAY_NEXT_CONDUCTOR_PORT;
    delete process.env.FRIDAY_NEXT_CONDUCTOR_HOST;
  });

  const expectedOpenclaw = {
    id: "openclaw",
    pathPrefixes: ["/friday-next", "/friday-next-admin", "/gateway", "/__openclaw__"],
    localPort: 18789,
    requiresAttest: true,
    denyPrefixes: [
      "/__openclaw__/control",
      "/__openclaw__/config",
      "/__openclaw__/api",
      "/__openclaw__",
    ],
    attestExemptPaths: [
      "/friday-next/attest",
      "/friday-next/health",
      "/friday-next/status",
      "/friday-next/plugin/info",
      "/friday-next/public-access/pairing",
      "/friday-next/pair/claim",
    ],
  };

  const expectedConductor = {
    id: "conductor",
    pathPrefixes: ["/cap"],
    localPort: 24080,
    localHost: "192.168.100.125",
    requiresAttest: true,
    allowedPaths: [
      "/cap/hello",
      "/cap/health",
      "/cap/events",
      "/cap/models",
      "/cap/cancel",
      "/cap/files",
      "/cap/approvals",
      "/cap/sessions",
      "/cap/workspaces",
    ],
    attestExemptPaths: ["/cap/health"],
  };

  it("builds the exact openclaw + conductor backend table", () => {
    const backends = buildTunnelBackends({
      ...baseConfig,
      conductorPort: 24080,
      conductorHost: "192.168.100.125",
    });
    expect(backends).toEqual([expectedOpenclaw, expectedConductor]);
  });

  it("omits the conductor backend when the port resolves to 0", () => {
    setFridayNextRuntime({
      config: { current: () => ({ channels: { "friday-next": { publicAccess: {} } } }) },
    });
    const backends = buildTunnelBackends({ ...baseConfig, conductorPort: 0 });
    expect(backends).toEqual([expectedOpenclaw]);
  });
});

describe("edgeConfigFor", () => {
  beforeEach(() => {
    setFridayNextRuntime({
      config: { current: () => ({ channels: { "friday-next": {} } }) },
    });
  });

  afterEach(() => {
    clearFridayNextRuntime();
  });

  it("returns the edge listen port, local backend table, and derived log level", () => {
    const cfg = {
      ...baseConfig,
      conductorPort: 24080,
      conductorHost: "192.168.100.125",
    };
    const config = edgeConfigFor(cfg);
    expect(config.listenPort).toBe(18790); // filterPort(corePort)
    expect(config.logLevel).toBe("info");
    expect(config.backends).toEqual(buildTunnelBackends(cfg));
  });
});
