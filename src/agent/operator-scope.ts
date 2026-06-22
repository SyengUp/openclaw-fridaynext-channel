// Operator-scope elevation for friday-next agent dispatch.
//
// Why this exists: friday-next registers all its routes with auth:"plugin" (it does
// its own device-token auth, not the gateway operator token). Core's
// createPluginRouteRuntimeScope gives auth!="gateway" routes an EMPTY operator-scope
// set. When an agent dispatched from such a route spawns a subagent, the spawn
// re-enters the in-process gateway `agent` method, which requires `operator.write`
// (core-descriptors: { name:"agent", scope:"operator.write" }). With an empty ambient
// scope the spawn fails with `{"error":"missing scope: operator.write"}`.
//
// The subagent spawn reads getPluginRuntimeGatewayRequestScope() at spawn time and
// uses that scope's client for authorization. Because AsyncLocalStorage returns the
// SAME store object reference, mutating its client.connect.scopes once — before we
// kick off the dispatch, while still inside the route's ALS context — propagates the
// elevated scopes to every later reader, including the subagent spawn.
//
// Subagent lifecycle admin methods (sessions.patch/delete) are unaffected: core pins
// those to ADMIN_SCOPE via a synthetic client, so only the `agent` method depends on
// this ambient operator.write. See memory: subagent-spawn-missing-operator-write.
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";

/** Operator scopes the friday-next dispatch needs so agents can spawn subagents. */
const REQUIRED_OPERATOR_SCOPES = ["operator.write", "operator.read"] as const;

type ScopeLike =
  | {
      client?: { connect?: { scopes?: unknown } };
    }
  | null
  | undefined;

/**
 * Adds the required operator scopes to a gateway-request-scope's
 * `client.connect.scopes` array in place. Pure and idempotent.
 * Returns the scopes that were actually added (empty if none / no array present).
 */
export function elevateScopeForSubagentSpawn(scope: ScopeLike): string[] {
  const connect = scope?.client?.connect;
  if (!connect || !Array.isArray(connect.scopes)) {
    return [];
  }
  const scopes = connect.scopes as string[];
  const added: string[] = [];
  for (const scopeName of REQUIRED_OPERATOR_SCOPES) {
    if (!scopes.includes(scopeName)) {
      scopes.push(scopeName);
      added.push(scopeName);
    }
  }
  return added;
}

/**
 * Fetches the live plugin gateway-request-scope and elevates it so the dispatched
 * agent can spawn subagents. Never throws — returns the scopes added (or []).
 */
export function ensureSubagentSpawnScope(): string[] {
  try {
    return elevateScopeForSubagentSpawn(getPluginRuntimeGatewayRequestScope());
  } catch {
    return [];
  }
}
