import { describe, it, expect } from "vitest";
import { adaptToolsCatalogHandler } from "./tool-catalog.js";

const CATALOG = {
  agentId: "main",
  profiles: [{ id: "minimal", label: "Minimal" }],
  groups: [
    {
      id: "core",
      label: "Core",
      source: "core",
      tools: [
        {
          id: "read",
          label: "Read",
          description: "read files",
          source: "core",
          defaultProfiles: ["minimal"],
        },
      ],
    },
  ],
};

describe("adaptToolsCatalogHandler (OpenClaw ≥2026.7.1 gateway-method handler shape)", () => {
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
