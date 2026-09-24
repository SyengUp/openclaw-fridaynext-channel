/**
 * GET /friday-next-admin/tool-catalog?agentId=<id>
 *
 * Gateway-authed sibling of `GET /friday-next/agents/{id}/tools/catalog`. Returns the
 * agent's full tool catalog (core + plugin tools, grouped by category, with descriptions,
 * profiles, and per-tool effective `enabled`/`inProfile` state) for the app's toolbox
 * editor — mirroring ControlUI.
 *
 * WHY THE `/friday-next-admin` SIBLING PREFIX (not `/friday-next`):
 * `/friday-next` is registered `auth: "plugin"`, and core gives plugin-authed routes a
 * runtime client with an EMPTY operator scope list (see `createPluginRouteRuntimeScope` in
 * gateway/server/plugins-http.ts), so dispatching the scoped `tools.catalog` method from
 * there is refused (`missing scope: operator.read`). A gateway-authed route cannot overlap
 * that prefix, so it lives next door — same reasoning as `commands-list.ts` /
 * `agent-identity.ts`. The app calls this with the gateway token it already uses for the
 * other `/friday-next-admin/*` routes.
 *
 * Like `commands-list.ts`, this does NOT ask for `gatewayRuntimeScopeSurface:
 * "trusted-operator"`: `tools.catalog` only needs `operator.read`, which the default
 * surface's `operator.write` already satisfies. Least privilege for a read-only listing.
 *
 * Dispatch also requires the manifest's
 * `contracts.gatewayMethodDispatch: ["authenticated-request"]` (already declared).
 *
 * The deep-import path is gone here on purpose: it executed a captured core dist chunk that
 * transitively needs `jiti`, which OpenClaw's external-plugin staging does not ship, so it
 * failed with `ERR_MODULE_NOT_FOUND: jiti` on 2026.9.5+. The gateway method runs core's real
 * builder in-process instead.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { isPublicRequest } from "../middleware/public-surface.js";
import { verifySession } from "../../attest/attest-store.js";
import { attestGateDecision, ATTEST_REJECTION_BODY } from "../../attest/attest-gate.js";
import { resolveFridayNextConfig } from "../../config.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { getFridayNextRuntime } from "../../runtime.js";
import { getFridayAgentForwardRuntime } from "../../agent-forward-runtime.js";
import { normalizeAgentId } from "../../agent-id.js";
import { buildAgentToolsCatalog } from "../../tool-catalog.js";

function json(res: ServerResponse, status: number, body: Record<string, unknown>): true {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
  return true;
}

export async function handleAdminToolCatalog(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET") {
    return json(res, 405, { error: "Method Not Allowed" });
  }

  // App Attest gate, mirroring commands-list.ts: this route lives under a SIBLING prefix
  // so the shared gate never sees it, yet the filter proxy exposes it publicly. Gate
  // PUBLIC-marked requests only (check the marker before touching the runtime).
  if (isPublicRequest(req)) {
    const attestCfg = resolveFridayNextConfig(
      getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
    );
    const gate = attestGateDecision({
      pathname: "/friday-next-admin/tool-catalog",
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

  const cfg = getFridayAgentForwardRuntime()?.getConfig();
  const catalog = await buildAgentToolsCatalog(cfg, agentId);
  if (!catalog) {
    return json(res, 503, { error: "Tool catalog unavailable" });
  }
  return json(res, 200, { ok: true, id: agentId, ...catalog });
}
