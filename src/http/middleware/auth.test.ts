import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { extractBearerToken } from "./auth.js";
import { setFridayNextRuntime } from "../../runtime.js";

function setConfig(config: unknown): void {
  setFridayNextRuntime({
    config: { loadConfig: () => config },
  } as never);
}

function req(auth?: string): IncomingMessage {
  return { headers: auth ? { authorization: auth } : {} } as IncomingMessage;
}

describe("extractBearerToken", () => {
  it("uses gateway.auth.token with highest priority", () => {
    setConfig({
      gateway: { auth: { token: "gateway-token" } },
      channels: {
        "friday-next": { authToken: "plugin-token" },
      },
    });
    expect(extractBearerToken(req("Bearer gateway-token"))).toBe("gateway-token");
    expect(extractBearerToken(req("Bearer plugin-token"))).toBeNull();
  });

  it("falls back to plugin authToken", () => {
    setConfig({
      channels: {
        "friday-next": { authToken: "plugin-token" },
      },
    });
    expect(extractBearerToken(req("Bearer plugin-token"))).toBe("plugin-token");
  });

  it("returns null for missing or malformed header", () => {
    setConfig({
      channels: {
        "friday-next": { authToken: "x" },
      },
    });
    expect(extractBearerToken(req())).toBeNull();
    expect(extractBearerToken(req("x y z"))).toBeNull();
  });
});
