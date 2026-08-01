/**
 * GET /friday-next-admin/commands?agentId=<id>
 *
 * Enumerates the slash commands the app's composer menu offers. Forwards to the
 * canonical gateway method `commands.list`, which is the ONLY place that merges
 * all three command sources core knows about:
 *   1. built-ins            (`buildBuiltinChatCommands`, ~45 entries)
 *   2. skill commands       (per-agent — hence the `agentId` param)
 *   3. plugin commands      (registered by other channel/provider plugins)
 * …and then applies the operator's config filters (`/config`, `/mcp`, `/bash`
 * and friends can be switched off) plus the protocol's length/count clamps.
 * ControlUI's chat composer calls the same method — this route just re-exposes
 * it on the app's REST surface.
 *
 * WHY THE `/friday-next-admin` SIBLING PREFIX (not `/friday-next`):
 * `/friday-next` is registered `auth: "plugin"`, and core gives plugin-authed
 * routes a runtime client with an EMPTY operator scope list (see
 * `createPluginRouteRuntimeScope` in gateway/server/plugins-http.ts), so
 * dispatching any scoped method from there is refused. A gateway-authed route
 * cannot overlap that prefix, so it lives next door — same reasoning as
 * `session-delete.ts` / `agent-identity.ts`.
 *
 * Unlike those two, this one does NOT ask for `gatewayRuntimeScopeSurface:
 * "trusted-operator"`: `commands.list` only needs `operator.read`, and the
 * default surface's `operator.write` already satisfies it
 * (`operatorScopeSatisfied` in shared/operator-scope-compat.ts). Least privilege
 * for a read-only listing.
 *
 * Dispatch also requires the manifest's
 * `contracts.gatewayMethodDispatch: ["authenticated-request"]` (already declared).
 *
 * Failure is soft: any dispatch error returns `200 { ok: false, commands: [] }`
 * so the app silently falls back to its built-in table instead of losing the
 * menu entirely (an old gateway without `commands.list` is a normal state).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { isPublicRequest } from "../middleware/public-surface.js";
import { verifySession } from "../../attest/attest-store.js";
import { attestGateDecision, ATTEST_REJECTION_BODY } from "../../attest/attest-gate.js";
import { resolveFridayNextConfig } from "../../config.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { getFridayNextRuntime } from "../../runtime.js";
import { normalizeAgentId } from "../../agent-id.js";

function json(res: ServerResponse, status: number, body: Record<string, unknown>): true {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
  return true;
}

export async function handleCommandsList(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET") {
    return json(res, 405, { error: "Method Not Allowed" });
  }

  // App Attest gate, mirroring server.ts's for `/friday-next/*`: this route lives under a
  // SIBLING prefix so the shared gate never sees it, yet the filter proxy exposes it publicly.
  // Gate PUBLIC-marked requests only (the marker is a header — check it before touching the
  // runtime, so LAN requests never need a configured runtime at all).
  if (isPublicRequest(req)) {
    const attestCfg = resolveFridayNextConfig(
      getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
    );
    const gate = attestGateDecision({
      pathname: "/friday-next-admin/commands",
      headers: req.headers,
      isPublic: true,
      required: attestCfg.appAttest.required,
      scope: "plugin",
      verify: (t) => verifySession(t, Date.now()),
    });
    if (gate === "reject") return json(res, 403, { ...ATTEST_REJECTION_BODY });
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const agentId = normalizeAgentId(url.searchParams.get("agentId") ?? undefined);

  let response;
  try {
    response = await dispatchGatewayMethod("commands.list", {
      agentId,
      // The app is a TEXT command surface — it never registers provider-native
      // commands, so `scope: "text"` also makes each entry's `name` the text
      // alias (no leading slash) instead of the native name.
      scope: "text",
      // Args carry the `<arg>` hints and static choice lists the menu shows.
      includeArgs: true,
    });
  } catch (err) {
    return json(res, 200, {
      ok: false,
      commands: [],
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!response.ok) {
    return json(res, 200, {
      ok: false,
      commands: [],
      error: response.error?.message ?? "commands.list failed",
      ...(response.error?.code ? { code: response.error.code } : {}),
    });
  }

  const payload = (response.payload ?? {}) as { commands?: unknown };
  return json(res, 200, {
    ok: true,
    agentId,
    commands: Array.isArray(payload.commands) ? payload.commands : [],
  });
}
