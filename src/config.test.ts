import { describe, expect, it } from "vitest";
import { resolveFridayNextConfig } from "./config.js";

describe("resolveFridayNextConfig", () => {
  it("uses defaults", () => {
    const cfg = resolveFridayNextConfig({});
    expect(cfg.channelId).toBe("friday-next");
    expect(cfg.logLevel).toBe("info");
    expect(cfg.sseKeepaliveSec).toBe(30);
    expect(cfg.publicAccess.enabled).toBe(true);
    expect(cfg.publicAccess.edgeMode).toBe("in-process");
    expect(cfg.publicAccess.conductorPort).toBe(0);
    expect(cfg.publicAccess.conductorHost).toBe("127.0.0.1");
  });

  it("resolves edgeMode with an in-process default and external override", () => {
    expect(
      resolveFridayNextConfig({
        channels: { "friday-next": { publicAccess: { edgeMode: "external" } } },
      }).publicAccess.edgeMode,
    ).toBe("external");
    expect(
      resolveFridayNextConfig({
        channels: { "friday-next": { publicAccess: { edgeMode: "bogus" } } },
      }).publicAccess.edgeMode,
    ).toBe("in-process");
  });

  it("keeps an operator-only hard stop for zero-egress deployments", () => {
    expect(
      resolveFridayNextConfig({
        channels: { "friday-next": { publicAccess: { standbyDisabled: true } } },
      }).publicAccess.enabled,
    ).toBe(false);
    expect(
      resolveFridayNextConfig({
        channels: { "friday-next": { publicAccess: { enabled: false } } },
      }).publicAccess.enabled,
    ).toBe(false);
  });

  it("resolves the conductor public backend port and host", () => {
    const cfg = resolveFridayNextConfig({
      channels: {
        "friday-next": {
          publicAccess: { conductorPort: 24080, conductorHost: "192.168.100.124" },
        },
      },
    });
    expect(cfg.publicAccess.conductorPort).toBe(24080);
    expect(cfg.publicAccess.conductorHost).toBe("192.168.100.124");
  });

  it("prefers gateway auth token over channel token", () => {
    const cfg = resolveFridayNextConfig({
      gateway: { auth: { token: "g1" } },
      channels: { "friday-next": { authToken: "c1" } },
    });
    expect(cfg.authToken).toBe("g1");
  });

  it("clamps numeric settings to schema bounds", () => {
    const cfg = resolveFridayNextConfig({
      channels: {
        "friday-next": {
          historyLimit: 9999,
          sse: { keepaliveSec: 1, backlogPerDevice: -2 },
        },
      },
    });
    expect(cfg.historyLimit).toBe(200);
    expect(cfg.sseKeepaliveSec).toBe(5);
    expect(cfg.sseBacklogPerDevice).toBe(0);
  });
});
