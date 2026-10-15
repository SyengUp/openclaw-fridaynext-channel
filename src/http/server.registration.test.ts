import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { registerFridayNextHttpRoutes } from "./server.js";
import { setMockRuntime } from "../test-support/mock-runtime.js";

describe("FridayNext HTTP route registration", () => {
  it("消息切点按各自所需的 operator 权限注册", () => {
    setMockRuntime({ authToken: "test-token" });
    const routes: Array<Record<string, unknown>> = [];
    registerFridayNextHttpRoutes({
      logger: { info: vi.fn(), warn: vi.fn() },
      registerHttpRoute: (route) => routes.push(route),
    });
    expect(
      routes.find((route) => route.path === "/friday-next-admin/sessions/rewind"),
    ).toMatchObject({
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
    });
    const fork = routes.find((route) => route.path === "/friday-next-admin/sessions/fork");
    expect(fork).toMatchObject({ auth: "gateway", match: "exact" });
    expect(fork).not.toHaveProperty("gatewayRuntimeScopeSurface");
  });

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

  it("registers session read state with gateway auth and least-privilege scopes", () => {
    setMockRuntime({ authToken: "test-token" });
    const routes: Array<Record<string, unknown>> = [];

    registerFridayNextHttpRoutes({
      logger: { info: vi.fn(), warn: vi.fn() },
      registerHttpRoute: (route) => routes.push(route),
    });

    expect(routes.find((route) => route.path === "/friday-next-admin/sessions/state")).toEqual(
      expect.objectContaining({
        auth: "gateway",
        match: "exact",
      }),
    );
    expect(
      routes.find((route) => route.path === "/friday-next-admin/sessions/state"),
    ).not.toHaveProperty("gatewayRuntimeScopeSurface");
  });

  it("routes non-PUT session pin requests to the handler for a 405 response", async () => {
    setMockRuntime({ authToken: "test-token" });
    const routes: Array<Record<string, unknown>> = [];
    registerFridayNextHttpRoutes({
      logger: { info: vi.fn(), warn: vi.fn() },
      registerHttpRoute: (route) => routes.push(route),
    });
    const pluginRoute = routes.find((route) => route.path === "/friday-next") as
      | {
          handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
        }
      | undefined;
    const response = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn(),
    };

    const handled = await pluginRoute?.handler(
      {
        method: "GET",
        url: "/friday-next/sessions/pin",
        headers: {},
      } as IncomingMessage,
      response as unknown as ServerResponse,
    );

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(405);
  });
});
