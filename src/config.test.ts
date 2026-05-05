import { describe, expect, it } from "vitest";
import { resolveFridayNextConfig } from "./config.js";

describe("resolveFridayNextConfig", () => {
  it("uses defaults", () => {
    const cfg = resolveFridayNextConfig({});
    expect(cfg.channelId).toBe("friday-next");
    expect(cfg.pathPrefix).toBe("/friday-next");
    expect(cfg.sseKeepaliveSec).toBe(30);
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
