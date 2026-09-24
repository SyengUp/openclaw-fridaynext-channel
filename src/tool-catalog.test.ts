import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adaptToolsCatalogHandler,
  buildAgentToolsCatalog,
  orderOpenClawDistModuleCandidates,
} from "./tool-catalog.js";

const { dispatchGatewayMethod } = vi.hoisted(() => ({
  dispatchGatewayMethod: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({
  dispatchGatewayMethod,
}));

const CATALOG = {
  agentId: "main",
  profiles: [
    { id: "minimal", label: "Minimal" },
    { id: "coding", label: "Coding" },
  ],
  groups: [
    {
      id: "fs",
      label: "Files",
      source: "core",
      tools: [
        {
          id: "read",
          label: "Read",
          description: "read files",
          source: "core",
          defaultProfiles: ["minimal"],
        },
        {
          id: "write",
          label: "Write",
          description: "write files",
          source: "core",
          defaultProfiles: ["coding"],
        },
      ],
    },
  ],
};

beforeEach(() => {
  dispatchGatewayMethod.mockReset();
});

describe("buildAgentToolsCatalog (via gateway tools.catalog method)", () => {
  it("dispatches the gateway method and derives per-tool state", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: CATALOG });
    const cfg = { agents: { entries: { main: { tools: { profile: "minimal" } } } } };

    const catalog = await buildAgentToolsCatalog(cfg, "main");

    expect(dispatchGatewayMethod).toHaveBeenCalledWith("tools.catalog", {
      agentId: "main",
      includePlugins: true,
    });
    expect(catalog?.profile).toBe("minimal");
    const tools = catalog!.groups[0].tools;
    expect(tools).toEqual([
      {
        id: "read",
        label: "Read",
        description: "read files",
        source: "core",
        enabled: true,
        inProfile: true,
      },
      {
        id: "write",
        label: "Write",
        description: "write files",
        source: "core",
        enabled: false,
        inProfile: false,
      },
    ]);
  });

  it("treats an unset profile with no allow list as allow-all, honoring deny", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: CATALOG });
    const cfg = { agents: { entries: { main: { tools: { deny: ["write"] } } } } };

    const catalog = await buildAgentToolsCatalog(cfg, "main");

    expect(catalog?.profile).toBeNull();
    const byId = Object.fromEntries(catalog!.groups[0].tools.map((t) => [t.id, t.enabled]));
    expect(byId).toEqual({ read: true, write: false });
  });

  it("re-includes a tool via alsoAllow when the profile would exclude it", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: CATALOG });
    const cfg = {
      agents: { entries: { main: { tools: { profile: "minimal", alsoAllow: ["write"] } } } },
    };

    const catalog = await buildAgentToolsCatalog(cfg, "main");

    const byId = Object.fromEntries(
      catalog!.groups[0].tools.map((t) => [t.id, { enabled: t.enabled, inProfile: t.inProfile }]),
    );
    expect(byId).toEqual({
      read: { enabled: true, inProfile: true },
      write: { enabled: true, inProfile: false },
    });
  });

  it("degrades to null when the gateway method responds with an error", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: false, error: { code: "UNAVAILABLE" } });
    await expect(buildAgentToolsCatalog({}, "main")).resolves.toBeNull();
  });

  it("degrades to null when dispatch throws (outside a plugin request scope)", async () => {
    dispatchGatewayMethod.mockRejectedValue(new Error("no scope"));
    await expect(buildAgentToolsCatalog({}, "main")).resolves.toBeNull();
  });

  it("degrades to null when the payload shape is unexpected", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { nope: true } });
    await expect(buildAgentToolsCatalog({}, "main")).resolves.toBeNull();
  });
});

describe("adaptToolsCatalogHandler (legacy ≤2026.9.4 gateway-method handler shape)", () => {
  it("returns null for a non-function handler", () => {
    expect(adaptToolsCatalogHandler(undefined)).toBeNull();
    expect(adaptToolsCatalogHandler({})).toBeNull();
  });

  it("drives the handler with params + context.getRuntimeConfig and returns the respond payload", () => {
    const seen: Record<string, unknown> = {};
    const build = adaptToolsCatalogHandler(
      (args: {
        params: { agentId?: string; includePlugins?: boolean };
        respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
        context: { getRuntimeConfig: () => unknown };
      }) => {
        seen.params = args.params;
        seen.cfg = args.context.getRuntimeConfig();
        args.respond(true, CATALOG, undefined);
      },
    );
    expect(build).not.toBeNull();

    const cfg = { agents: { list: [] } };
    const result = build!({ cfg, agentId: "main", includePlugins: true });

    expect(result).toEqual(CATALOG);
    expect(seen.params).toEqual({ agentId: "main", includePlugins: true });
    expect(seen.cfg).toBe(cfg);
  });

  it("throws when the handler responds with an error (caller degrades to null)", () => {
    const build = adaptToolsCatalogHandler(
      (args: { respond: (ok: boolean, payload?: unknown, error?: unknown) => void }) => {
        args.respond(false, undefined, { code: "INVALID_REQUEST", message: "bad params" });
      },
    );
    expect(() => build!({ cfg: {}, agentId: "main", includePlugins: true })).toThrow(
      /tools\.catalog handler failed/,
    );
  });
});

describe("orderOpenClawDistModuleCandidates", () => {
  it("discovers 2026.9.3 .mjs chunks while retaining legacy .js compatibility", () => {
    expect(
      orderOpenClawDistModuleCandidates(
        [
          "unrelated.txt",
          "runtime-old.js",
          "tools-catalog-new.mjs",
          "tools-catalog-old.js",
          "runtime-new.mjs",
          "types.d.ts",
        ],
        "tools-catalog-",
      ),
    ).toEqual([
      "tools-catalog-new.mjs",
      "tools-catalog-old.js",
      "runtime-new.mjs",
      "runtime-old.js",
    ]);
  });
});
