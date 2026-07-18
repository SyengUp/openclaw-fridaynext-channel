/**
 * DELETE /friday-next-admin/sessions?sessionKey=<key>
 *
 * Permanent server-side session deletion — the "proper" path. Unlike the app's
 * legacy local-only teardown (which left the server session alive so history
 * sync would resurrect it), this dispatches the canonical gateway `sessions.delete`
 * method: it aborts any in-flight run, removes the `sessions.json` entry, archives
 * the transcript (`.jsonl.deleted.<iso>`), and broadcasts `sessions.changed`.
 *
 * This route is registered with `auth: "gateway"` + `gatewayRuntimeScopeSurface:
 * "trusted-operator"` (NOT the `/friday-next` `auth: "plugin"` prefix — a
 * gateway-authed route cannot overlap that prefix). Gateway HTTP auth runs before
 * this handler; the shared-secret bearer (= `gateway.auth.token`, the same token
 * the app already sends) resolves to the full CLI operator scope set including
 * `operator.admin`, which `sessions.delete` requires. The route's runtime client
 * carries no `pluginRuntimeOwnerId`, so core's plugin-owner delete guard does not
 * fire and the app can delete its own regular channel sessions.
 *
 * Dispatch requires the manifest to declare
 * `contracts.gatewayMethodDispatch: ["authenticated-request"]`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { isPublicRequest } from "../middleware/public-surface.js";
import { verifySession } from "../../attest/attest-store.js";
import { resolveFridayNextConfig } from "../../config.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { getFridayNextRuntime } from "../../runtime.js";

function json(res: ServerResponse, status: number, body: Record<string, unknown>): true {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
  return true;
}

/** Maps a gateway error code to an HTTP status. */
function statusForErrorCode(code: string | undefined): number {
  switch (code) {
    case "INVALID_REQUEST":
      // e.g. attempting to delete the protected main session.
      return 400;
    case "NOT_LINKED":
    case "NOT_PAIRED":
      return 409;
    case "UNAVAILABLE":
      return 503;
    case "AGENT_TIMEOUT":
      return 504;
    default:
      return 500;
  }
}

export async function handleSessionDelete(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "DELETE") {
    return json(res, 405, { error: "Method Not Allowed" });
  }

  // App Attest gate, mirroring server.ts's for `/friday-next/*`: this route lives under a
  // SIBLING prefix so the shared gate never sees it, yet the filter proxy exposes it publicly
  // — without this check a leaked bearer could permanently delete sessions from the internet.
  // Gate PUBLIC-marked requests only (the marker is a header — check it before touching the
  // runtime, so LAN requests never need a configured runtime at all).
  if (isPublicRequest(req)) {
    const attestCfg = resolveFridayNextConfig(
      getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
    );
    if (attestCfg.appAttest.required) {
      const sess = req.headers["x-fridaynext-attest"];
      const token = Array.isArray(sess) ? sess[0] : sess;
      if (!token || !verifySession(token, Date.now())) {
        return json(res, 403, { error: "app attestation required", code: "attest_required" });
      }
    }
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const sessionKey = (url.searchParams.get("sessionKey") ?? "").trim();
  if (!sessionKey) {
    return json(res, 400, { error: "Missing required query param: sessionKey" });
  }

  let response;
  try {
    response = await dispatchGatewayMethod("sessions.delete", {
      key: sessionKey,
      // `true` archives the transcript (soft-delete). Misnomer in core: it does
      // not hard-unlink — retention sweeps reap the archive later.
      deleteTranscript: true,
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!response.ok) {
    const code = response.error?.code;
    return json(res, statusForErrorCode(code), {
      ok: false,
      error: response.error?.message ?? "sessions.delete failed",
      ...(code ? { code } : {}),
    });
  }

  // sessions.delete payload: { ok, key, deleted, archived }
  const payload = (response.payload ?? {}) as {
    key?: unknown;
    deleted?: unknown;
    archived?: unknown;
  };
  return json(res, 200, {
    ok: true,
    sessionKey,
    deleted: payload.deleted === true,
    ...(Array.isArray(payload.archived) ? { archived: payload.archived } : {}),
  });
}
