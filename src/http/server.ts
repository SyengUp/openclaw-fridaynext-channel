/**
 * HTTP server registration for the Friday channel.
 *
 * Registers routes on the gateway HTTP server under the /friday-next/ path prefix.
 * Routes are registered via the plugin API's registerHttpRoute method.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMessages } from "./handlers/messages.js";
import { handleSseStream } from "./handlers/sse.js";
import { handleFilesUpload } from "./handlers/files-upload.js";
import { handleFilesDownload } from "./handlers/files-download.js";
import { handleCancel } from "./handlers/cancel.js";
import { handleDeviceApprove } from "./handlers/device-approve.js";
import { handleNodesApprove } from "./handlers/nodes-approve.js";
import { handleApprovalDecision } from "./handlers/approvals.js";
import { handleSessionsSettings } from "./handlers/sessions-settings.js";
import { handleModelsList } from "./handlers/models-list.js";
import { handleAgentsList } from "./handlers/agents-list.js";
import { handleAgentConfig } from "./handlers/agent-config.js";
import { handleAgentFiles } from "./handlers/agent-files.js";
import { handleAgentToolsCatalog } from "./handlers/agent-tools-catalog.js";
import { handleHistorySessions } from "./handlers/history-sessions.js";
import { handleNotifications, handleNotificationDelete } from "./handlers/notifications.js";
import { handleHistoryMessages } from "./handlers/history-messages.js";
import { handleHistorySetTitle } from "./handlers/history-set-title.js";
import { handleStatus } from "./handlers/status.js";
import { handleLinkPreview } from "./handlers/link-preview.js";
import { handleHealth } from "./handlers/health.js";
import { handlePluginInfo } from "./handlers/plugin-info.js";
import { handlePluginUpgrade } from "./handlers/plugin-upgrade.js";
import { handlePublicAccessPairing } from "./handlers/plugin-pairing.js";
import {
  handleAttestChallenge,
  handleAttestVerify,
  handleAttestRefresh,
} from "./handlers/attest.js";
import { verifySession } from "../attest/attest-store.js";
import { handleSessionDelete } from "./handlers/session-delete.js";
import { applyCorsHeaders } from "./middleware/cors.js";
import { resolveFridayNextConfig } from "../config.js";
import { getHostOpenClawConfigSnapshot } from "../host-config.js";
import { getFridayNextRuntime } from "../runtime.js";
import { sseEmitter } from "../sse/emitter.js";

/** Paths exempt from the App Attest gate: the attest bootstrap itself, health, and
 * owner-side plugin/pairing management (Bearer-authed, used before/without an app
 * session). Everything else requires a valid session token when attest is on. */
function isAttestExempt(pathname: string): boolean {
  return (
    pathname.startsWith("/friday-next/attest/") ||
    pathname === "/friday-next/health" ||
    pathname === "/friday-next/status" || // server-side install-script connectivity probe
    pathname === "/friday-next/plugin/info" ||
    pathname === "/friday-next/plugin/upgrade" ||
    pathname === "/friday-next/public-access/pairing"
  );
}

/** True when the request arrived over the public relay tunnel. The public-surface
 * filter proxy — which EVERY public request must traverse — stamps this marker and
 * strips any client-supplied value, so it can't be forged from outside. LAN clients
 * hit core directly and never carry it. The App Attest gate keys off this so it
 * enforces "only the genuine app" on the PUBLIC surface only, leaving LAN untouched
 * (old apps keep working at home; a browser that finds the public URL is refused). */
function isPublicRequest(req: IncomingMessage): boolean {
  const v = req.headers["x-fridaynext-public"];
  return (Array.isArray(v) ? v[0] : v) === "1";
}

/** Route matcher - returns the matched handler or null. */
async function handleFridayNextRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  applyCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }

  // App Attest gate: on the PUBLIC surface only (isPublicRequest), when required,
  // every route except the bootstrap/owner-side allowlist must carry a valid session
  // token (proof the caller is the genuine FridayNext app). LAN requests never carry
  // the public marker, so they're never gated — old apps keep working at home, while
  // a browser/script that finds the public URL is refused.
  const attestCfg = resolveFridayNextConfig(
    getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
  );
  if (attestCfg.appAttest.required && isPublicRequest(req) && !isAttestExempt(pathname)) {
    const sess = req.headers["x-fridaynext-attest"];
    const token = Array.isArray(sess) ? sess[0] : sess;
    if (!token || !verifySession(token, Date.now())) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "app attestation required", code: "attest_required" }));
      return true;
    }
  }

  // Route: GET /friday-next/attest/challenge
  if (req.method === "GET" && pathname === "/friday-next/attest/challenge") {
    return handleAttestChallenge(req, res);
  }
  // Route: POST /friday-next/attest/verify
  if (req.method === "POST" && pathname === "/friday-next/attest/verify") {
    return await handleAttestVerify(req, res);
  }
  // Route: POST /friday-next/attest/refresh
  if (req.method === "POST" && pathname === "/friday-next/attest/refresh") {
    return await handleAttestRefresh(req, res);
  }

  // Route: GET /friday-next/events?deviceId=...
  if (req.method === "GET" && pathname === "/friday-next/events") {
    return await handleSseStream(req, res);
  }

  // Route: POST /friday-next/messages
  if (req.method === "POST" && pathname === "/friday-next/messages") {
    return await handleMessages(req, res);
  }

  // Route: POST /friday-next/files (multipart upload)
  if (req.method === "POST" && pathname === "/friday-next/files") {
    return await handleFilesUpload(req, res);
  }

  // Route: GET /friday-next/files/:id (download)
  if (req.method === "GET" && pathname.startsWith("/friday-next/files/")) {
    return await handleFilesDownload(req, res);
  }

  if (req.method === "POST" && pathname === "/friday-next/cancel") {
    return await handleCancel(req, res);
  }

  if (req.method === "POST" && pathname === "/friday-next/device-approve") {
    return await handleDeviceApprove(req, res);
  }

  if (req.method === "POST" && pathname === "/friday-next/nodes-approve") {
    return await handleNodesApprove(req, res);
  }

  // Route: POST /friday-next/approvals/{approvalId} (submit exec/plugin approval decision)
  if (req.method === "POST" && pathname.startsWith("/friday-next/approvals/")) {
    const approvalId = decodeURIComponent(pathname.slice("/friday-next/approvals/".length));
    return await handleApprovalDecision(req, res, approvalId);
  }

  if (
    (req.method === "PUT" || req.method === "GET") &&
    pathname === "/friday-next/sessions/settings"
  ) {
    return await handleSessionsSettings(req, res);
  }

  if (req.method === "GET" && pathname === "/friday-next/models") {
    return await handleModelsList(req, res);
  }

  if (req.method === "GET" && pathname === "/friday-next/agents") {
    return await handleAgentsList(req, res);
  }

  // Routes: GET/PUT /friday-next/agents/{id}/config
  //         GET     /friday-next/agents/{id}/files
  //         GET/PUT /friday-next/agents/{id}/files/{name}
  if (pathname.startsWith("/friday-next/agents/")) {
    const segs = pathname
      .slice("/friday-next/agents/".length)
      .split("/")
      .filter(Boolean)
      .map((s) => decodeURIComponent(s));
    const [id, sub, name] = segs;
    if (id && sub === "config" && segs.length === 2) {
      return await handleAgentConfig(req, res, id);
    }
    if (id && sub === "files" && (segs.length === 2 || segs.length === 3)) {
      return await handleAgentFiles(req, res, id, name);
    }
    if (id && sub === "tools" && name === "catalog" && segs.length === 3) {
      return await handleAgentToolsCatalog(req, res, id);
    }
  }

  if (req.method === "GET" && pathname === "/friday-next/status") {
    return await handleStatus(req, res);
  }

  // Route: GET /friday-next/history/sessions (list all sessions across agents)
  if (req.method === "GET" && pathname === "/friday-next/history/sessions") {
    return await handleHistorySessions(req, res);
  }

  // Route: GET /friday-next/notifications (durable agent-initiated background pushes: cron/heartbeat)
  if (req.method === "GET" && pathname === "/friday-next/notifications") {
    return await handleNotifications(req, res);
  }

  // Route: DELETE /friday-next/notifications/:seq (permanent server-side removal)
  if (req.method === "DELETE" && pathname.startsWith("/friday-next/notifications/")) {
    const seqRaw = decodeURIComponent(pathname.slice("/friday-next/notifications/".length));
    return await handleNotificationDelete(req, res, seqRaw);
  }

  // Route: GET /friday-next/history/messages?sessionKey=&agentId=&limit=
  if (req.method === "GET" && pathname === "/friday-next/history/messages") {
    return await handleHistoryMessages(req, res);
  }

  // Route: PUT /friday-next/sessions/title (sync app session name → server displayName)
  if (
    (req.method === "PUT" || req.method === "POST") &&
    pathname === "/friday-next/sessions/title"
  ) {
    return await handleHistorySetTitle(req, res);
  }

  // Route: GET /friday-next/link-preview?url=... (Open Graph metadata for preview cards)
  if (req.method === "GET" && pathname === "/friday-next/link-preview") {
    return await handleLinkPreview(req, res);
  }

  // Route: GET /friday-next/health?deviceId=...&nodeDeviceId=...&selfHeal=true
  if (req.method === "GET" && pathname === "/friday-next/health") {
    return await handleHealth(req, res);
  }

  // Route: GET /friday-next/plugin/info (current/latest version + upgradability)
  if (req.method === "GET" && pathname === "/friday-next/plugin/info") {
    return await handlePluginInfo(req, res);
  }

  // Route: POST /friday-next/plugin/upgrade (npm install @latest + safe gateway restart)
  if (req.method === "POST" && pathname === "/friday-next/plugin/upgrade") {
    return await handlePluginUpgrade(req, res);
  }

  // Route: GET /friday-next/public-access/pairing (superset QR payload for guest sharing)
  if (req.method === "GET" && pathname === "/friday-next/public-access/pairing") {
    return await handlePublicAccessPairing(req, res);
  }

  // Not found
  return false;
}

export function registerFridayNextHttpRoutes(api: {
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
  registerHttpRoute: (route: {
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
    auth: string;
    match: string;
    /** Operator-scope surface for `auth: "gateway"` routes (e.g. "trusted-operator"). */
    gatewayRuntimeScopeSurface?: string;
  }) => void;
}): void {
  const cfg = resolveFridayNextConfig(getHostOpenClawConfigSnapshot(getFridayNextRuntime().config));
  sseEmitter.setBacklogLimit(cfg.sseBacklogPerDevice);
  if (!cfg.authToken) {
    api.logger.warn("friday-next authToken not configured; all requests will 401");
  }

  // Plugin handles its own auth via extractBearerToken()
  api.registerHttpRoute({
    path: "/friday-next",
    handler: handleFridayNextRoute,
    auth: "plugin",
    match: "prefix",
  });

  // Permanent server-side session deletion. Registered under a SIBLING prefix
  // (`/friday-next-admin`, not `/friday-next`) because a gateway-authed route
  // cannot overlap the `/friday-next` `auth: "plugin"` prefix (core rejects
  // overlapping routes with mismatched auth). `auth: "gateway"` +
  // "trusted-operator" grants the `operator.admin` scope that `sessions.delete`
  // requires; the shared-secret bearer the app already sends satisfies it.
  api.registerHttpRoute({
    path: "/friday-next-admin/sessions",
    handler: handleSessionDelete,
    auth: "gateway",
    match: "exact",
    gatewayRuntimeScopeSurface: "trusted-operator",
  });

  api.logger.info("Friday Next channel HTTP routes registered at /friday-next/*");
}
