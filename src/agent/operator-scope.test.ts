import { describe, it, expect, vi } from "vitest";

// The helper imports the live scope getter from core; the pure function under test
// never calls it, but the module-level import must resolve. Mock it so the unit test
// does not depend on the OpenClaw dist runtime.
const getScope = vi.fn();
vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: () => getScope(),
}));

import { elevateScopeForSubagentSpawn, ensureSubagentSpawnScope } from "./operator-scope.js";

function makeScope(scopes: string[]) {
  return { client: { connect: { role: "operator", scopes } } };
}

describe("elevateScopeForSubagentSpawn", () => {
  it("adds operator.write + operator.read to an empty plugin-route scope", () => {
    // friday-next routes register with auth:"plugin", which core gives EMPTY operator
    // scopes. Subagent spawn re-enters the gateway `agent` method (requires
    // operator.write) and fails with "missing scope: operator.write" without this.
    const scope = makeScope([]);
    const added = elevateScopeForSubagentSpawn(scope);
    expect(scope.client.connect.scopes).toContain("operator.write");
    expect(scope.client.connect.scopes).toContain("operator.read");
    expect(added).toEqual(["operator.write", "operator.read"]);
  });

  it("is idempotent — does not duplicate already-present scopes", () => {
    const scope = makeScope(["operator.write"]);
    const added = elevateScopeForSubagentSpawn(scope);
    expect(added).toEqual(["operator.read"]);
    expect(scope.client.connect.scopes.filter((s) => s === "operator.write")).toHaveLength(1);
  });

  it("preserves unrelated existing scopes", () => {
    const scope = makeScope(["operator.admin"]);
    elevateScopeForSubagentSpawn(scope);
    expect(scope.client.connect.scopes).toContain("operator.admin");
    expect(scope.client.connect.scopes).toContain("operator.write");
  });

  it("returns [] and never throws when no scope/client is present", () => {
    expect(elevateScopeForSubagentSpawn(undefined)).toEqual([]);
    expect(elevateScopeForSubagentSpawn(null)).toEqual([]);
    expect(elevateScopeForSubagentSpawn({})).toEqual([]);
    expect(elevateScopeForSubagentSpawn({ client: { connect: {} } })).toEqual([]);
  });
});

describe("ensureSubagentSpawnScope", () => {
  it("elevates the live scope returned by the SDK getter", () => {
    const scope = makeScope([]);
    getScope.mockReturnValue(scope);
    const added = ensureSubagentSpawnScope();
    expect(added).toEqual(["operator.write", "operator.read"]);
    expect(scope.client.connect.scopes).toContain("operator.write");
  });

  it("swallows errors from the getter and returns []", () => {
    getScope.mockImplementation(() => {
      throw new Error("no scope");
    });
    expect(ensureSubagentSpawnScope()).toEqual([]);
  });
});
