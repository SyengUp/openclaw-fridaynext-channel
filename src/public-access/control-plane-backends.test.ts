import { describe, expect, it } from "vitest";
import { clearFridayNextRuntime, setFridayNextRuntime } from "../runtime.js";
import {
  backendTablesEqual,
  buildTunnelBackends,
  parseControlPlaneBackends,
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

const validBackend = {
  id: "openclaw",
  pathPrefixes: ["/friday-next", "/gateway"],
  localPort: 18789,
  localHost: "127.0.0.1",
  requiresAttest: true,
  denyPrefixes: ["/__openclaw__"],
  allowedPaths: ["/friday-next/health"],
  attestExemptPaths: ["/friday-next/health"],
};

describe("parseControlPlaneBackends", () => {
  it("parses a valid backend array", () => {
    const parsed = parseControlPlaneBackends([validBackend]);
    expect(parsed).toEqual([validBackend]);
  });

  it("returns [] for an explicitly empty array", () => {
    expect(parseControlPlaneBackends([])).toEqual([]);
  });

  it("returns null when absent or not an array", () => {
    expect(parseControlPlaneBackends(undefined)).toBeNull();
    expect(parseControlPlaneBackends({})).toBeNull();
    expect(parseControlPlaneBackends("backends")).toBeNull();
  });

  it("rejects >16 backends", () => {
    const many = Array.from({ length: 17 }, (_, i) => ({
      ...validBackend,
      id: `b${i}`,
      pathPrefixes: [`/b${i}`],
    }));
    expect(parseControlPlaneBackends(many)).toBeNull();
  });

  it("rejects duplicate ids", () => {
    expect(
      parseControlPlaneBackends([
        validBackend,
        { ...validBackend, pathPrefixes: ["/other"] },
      ]),
    ).toBeNull();
  });

  it("rejects malformed entries without throwing", () => {
    const badCases: unknown[] = [
      "x",
      1,
      null,
      { ...validBackend, id: "" },
      { ...validBackend, pathPrefixes: [] },
      { ...validBackend, pathPrefixes: ["nope"] },
      { ...validBackend, pathPrefixes: [1] },
      { ...validBackend, localPort: 0 },
      { ...validBackend, localPort: 65536 },
      { ...validBackend, localPort: "18789" },
      { ...validBackend, localHost: "http://evil/x" },
      { ...validBackend, localHost: 42 },
      { ...validBackend, requiresAttest: "yes" },
      { ...validBackend, denyPrefixes: "nope" },
      { ...validBackend, denyPrefixes: ["ok", 1] },
      { ...validBackend, allowedPaths: ["/ok", "bad"] },
      { ...validBackend, attestExemptPaths: {} },
    ];
    for (const bad of badCases) {
      expect(parseControlPlaneBackends([bad]), JSON.stringify(bad)).toBeNull();
    }
  });

  it("accepts optional fields omitted", () => {
    const parsed = parseControlPlaneBackends([
      { id: "a", pathPrefixes: ["/a"], localPort: 1 },
    ]);
    expect(parsed).toEqual([{ id: "a", pathPrefixes: ["/a"], localPort: 1 }]);
  });
});

describe("backendTablesEqual", () => {
  it("compares by id/pathPrefixes/localPort/localHost only", () => {
    const a = {
      id: "openclaw",
      pathPrefixes: ["/friday-next"],
      localPort: 18789,
      requiresAttest: true,
      denyPrefixes: ["/deny-a"],
    };
    const b = {
      id: "openclaw",
      pathPrefixes: ["/friday-next"],
      localPort: 18789,
      requiresAttest: false,
      denyPrefixes: ["/deny-b"],
    };
    expect(backendTablesEqual([a], [b])).toBe(true);
  });

  it("treats omitted and explicit default localHost as equal", () => {
    expect(
      backendTablesEqual(
        [{ id: "a", pathPrefixes: ["/a"], localPort: 1 }],
        [{ id: "a", pathPrefixes: ["/a"], localPort: 1, localHost: "127.0.0.1" }],
      ),
    ).toBe(true);
  });

  it("detects differences in each routing-identity field", () => {
    const base = { id: "a", pathPrefixes: ["/a"], localPort: 1, localHost: "127.0.0.1" };
    expect(
      backendTablesEqual([base], [{ ...base, id: "b" }]),
    ).toBe(false);
    expect(
      backendTablesEqual([base], [{ ...base, pathPrefixes: ["/b"] }]),
    ).toBe(false);
    expect(
      backendTablesEqual([base], [{ ...base, localPort: 2 }]),
    ).toBe(false);
    expect(
      backendTablesEqual([base], [{ ...base, localHost: "192.168.100.124" }]),
    ).toBe(false);
  });

  it("detects length and order differences", () => {
    expect(
      backendTablesEqual(
        [{ id: "a", pathPrefixes: ["/a"], localPort: 1 }],
        [
          { id: "a", pathPrefixes: ["/a"], localPort: 1 },
          { id: "b", pathPrefixes: ["/b"], localPort: 2 },
        ],
      ),
    ).toBe(false);
    expect(
      backendTablesEqual(
        [
          { id: "a", pathPrefixes: ["/a"], localPort: 1 },
          { id: "b", pathPrefixes: ["/b"], localPort: 2 },
        ],
        [
          { id: "b", pathPrefixes: ["/b"], localPort: 2 },
          { id: "a", pathPrefixes: ["/a"], localPort: 1 },
        ],
      ),
    ).toBe(false);
  });

  it("compares the locally built table against itself as equal", () => {
    setFridayNextRuntime({
      config: { current: () => ({ channels: { "friday-next": { publicAccess: {} } } }) },
    });
    try {
      const cfg: PublicAccessConfig = { ...baseConfig, conductorPort: 0 };
      expect(backendTablesEqual(buildTunnelBackends(cfg), buildTunnelBackends(cfg))).toBe(true);
    } finally {
      clearFridayNextRuntime();
    }
  });
});
