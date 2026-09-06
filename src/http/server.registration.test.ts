import { describe, expect, it, vi } from "vitest";
import { registerFridayNextHttpRoutes } from "./server.js";
import { setMockRuntime } from "../test-support/mock-runtime.js";

describe("FridayNext HTTP route registration", () => {
  it("grants the Talk prefix the trusted operator surface required by OpenClaw 2026.7.1", () => {
    setMockRuntime({ authToken: "test-token" });
    const routes: Array<Record<string, unknown>> = [];

    registerFridayNextHttpRoutes({
      logger: { info: vi.fn(), warn: vi.fn() },
      registerHttpRoute: (route) => routes.push(route),
    });

    expect(routes.find((route) => route.path === "/friday-next-admin/talk")).toMatchObject({
      auth: "gateway",
      match: "prefix",
      gatewayRuntimeScopeSurface: "trusted-operator",
    });
  });
});
