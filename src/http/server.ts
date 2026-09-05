/**
 * HTTP server registration for the Friday channel.
 *
 * Registers routes on the gateway HTTP server under the /friday-next/ path prefix.
 * Routes are registered via the plugin API's registerHttpRoute method.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { isPublicRequest } from "./middleware/public-surface.js";
import { handleMessages } from "./handlers/messages.js";
import { handleSseStream } from "./handlers/sse.js";
import { handleFilesUpload } from "./handlers/files-upload.js";
import { handleFilesDownload } from "./handlers/files-download.js";
import { handleCancel } from "./handlers/cancel.js";
import { handleDeviceApprove } from "./handlers/device-approve.js";
import { handleNodesApprove } from "./handlers/nodes-approve.js";
import { handleApprovalDecision } from "./handlers/approvals.js";
import { handleSessionsSettings } from "./handlers/sessions-settings.js";
import { handlePromptCapsules } from "./handlers/prompt-capsules.js";
import { handleServerName } from "./handlers/server-name.js";
import { handleModelsList, handleAdminModelsList } from "./handlers/models-list.js";
import { handleAgentsList } from "./handlers/agents-list.js";
import { handleAgentConfig } from "./handlers/agent-config.js";
import { handleAgentGreeting } from "./handlers/agent-greetings.js";
import { handleAgentFiles } from "./handlers/agent-files.js";
import { handleAgentToolsCatalog } from "./handlers/agent-tools-catalog.js";
import { handleHistorySessions } from "./handlers/history-sessions.js";
import { handleNotifications, handleNotificationDelete } from "./handlers/notifications.js";
import { handleHistoryMessages } from "./handlers/history-messages.js";
import { handleHistorySetTitle } from "./handlers/history-set-title.js";
import { handleSessionsBind } from "./handlers/sessions-bind.js";
import { handleStatus } from "./handlers/status.js";
import { handleLinkPreview } from "./handlers/link-preview.js";
import { handleHealth } from "./handlers/health.js";
import { handlePluginInfo } from "./handlers/plugin-info.js";
import { handlePluginUpgrade, handlePluginUpgradeStatus } from "./handlers/plugin-upgrade.js";
import { handlePairClaim, handlePublicAccessPairing } from "./handlers/plugin-pairing.js";
import {
  handleAttestChallenge,
  handleAttestVerify,
  handleAttestRefresh,
} from "./handlers/attest.js";
import { verifySession } from "../attest/attest-store.js";
import { attestGateDecision, ATTEST_REJECTION_BODY } from "../attest/attest-gate.js";
import { handleSessionDelete } from "./handlers/session-delete.js";
import { handleAgentIdentity } from "./handlers/agent-identity.js";
import { handleCommandsList } from "./handlers/commands-list.js";
import {
  handleCronJobs,
  handleCronJobRun,
  handleCronRuns,
  handleCronChannels,
} from "./handlers/cron.js";
import { handleTalk } from "./handlers/talk.js";
import { handleHealthQueryResult } from "./handlers/health-query-result.js";
import { handleCalendarResult } from "./handlers/calendar-result.js";
import { handleLocationQueryResult } from "./handlers/location-query-result.js";
import { applyCorsHeaders } from "./middleware/cors.js";
import { resolveFridayNextConfig } from "../config.js";
import { getHostOpenClawConfigSnapshot } from "../host-config.js";
import { getFridayNextRuntime } from "../runtime.js";
import { sseEmitter } from "../sse/emitter.js";

// The gate's decision (and its exemption table) lives in attest/attest-gate.ts — shared with
// session-delete.ts's sibling-prefix copy and the filter proxy's core-surface gate.
// isPublicRequest moved to middleware/public-surface.ts (shared with the SSE handler's
// per-connection viaPublic tracking for the OSS side-channel divert).

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
  const gate = attestGateDecision({
    pathname,
    headers: req.headers,
    isPublic: isPublicRequest(req),
    required: attestCfg.appAttest.required,
    scope: "plugin",
    verify: (t) => verifySession(t, Date.now()),
  });
  if (gate === "reject") {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(ATTEST_REJECTION_BODY));
    return true;
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

  if (req.method === "POST" && pathname === "/friday-next/health-query/result") {
    return await handleHealthQueryResult(req, res);
  }

  if (req.method === "POST" && pathname === "/friday-next/calendar/result") {
    return await handleCalendarResult(req, res);
  }

  if (req.method === "POST" && pathname === "/friday-next/location/result") {
    return await handleLocationQueryResult(req, res);
  }

  if (
    (req.method === "PUT" || req.method === "GET") &&
    pathname === "/friday-next/sessions/settings"
  ) {
    return await handleSessionsSettings(req, res);
  }

  // Route: GET/PUT /friday-next/prompt-capsules (gateway source of truth; new stores get the starter)
  if (
    (req.method === "GET" || req.method === "PUT") &&
    pathname === "/friday-next/prompt-capsules"
  ) {
    return await handlePromptCapsules(req, res);
  }

  // Route: GET/PUT /friday-next/server-name (this gateway's display name, shared by all devices)
  if ((req.method === "GET" || req.method === "PUT") && pathname === "/friday-next/server-name") {
    return await handleServerName(req, res);
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
    if (id && sub === "greeting" && segs.length === 2) {
      return await handleAgentGreeting(req, res, id);
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

  // Route: POST /friday-next/sessions/bind (attach a device to a session's live
  // stream + replay that session's buffered frames — Control-UI-started runs)
  if (req.method === "POST" && pathname === "/friday-next/sessions/bind") {
    return await handleSessionsBind(req, res);
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

  // Route: POST /friday-next/plugin/upgrade (async npm install @latest + safe gateway restart)
  if (req.method === "POST" && pathname === "/friday-next/plugin/upgrade") {
    return await handlePluginUpgrade(req, res);
  }

  // Route: GET /friday-next/plugin/upgrade/status (async upgrade progress)
  if (req.method === "GET" && pathname === "/friday-next/plugin/upgrade/status") {
    return await handlePluginUpgradeStatus(req, res);
  }

  // Route: GET /friday-next/public-access/pairing (superset QR payload for guest sharing)
  if (req.method === "GET" && pathname === "/friday-next/public-access/pairing") {
    return await handlePublicAccessPairing(req, res);
  }

  // Route: POST /friday-next/pair/claim (D12 — one-time voucher → bearer token; the
  // voucher is the credential, so no bearer/attest gate; see handler for rate limits)
  if (req.method === "POST" && pathname === "/friday-next/pair/claim") {
    return await handlePairClaim(req, res);
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

  // Agent rename. Same sibling-prefix + trusted-operator reasoning as above:
  // the canonical `agents.update` method requires `operator.admin`.
  api.registerHttpRoute({
    path: "/friday-next-admin/agents/identity",
    handler: handleAgentIdentity,
    auth: "gateway",
    match: "exact",
    gatewayRuntimeScopeSurface: "trusted-operator",
  });

  // Slash-command catalog for the composer menu. Same sibling-prefix reasoning
  // (plugin-authed routes get an empty operator scope list, so they can't
  // dispatch scoped methods), but NO "trusted-operator": `commands.list` only
  // needs `operator.read`, which the default surface's `operator.write` already
  // satisfies. Least privilege for a read-only listing.
  api.registerHttpRoute({
    path: "/friday-next-admin/commands",
    handler: handleCommandsList,
    auth: "gateway",
    match: "exact",
  });

  // Model catalog for the composer/agent model pickers. Same sibling-prefix +
  // least-privilege reasoning as `/friday-next-admin/commands`: `models.list`
  // (the same method Control UI's chat page calls) only needs `operator.read`.
  api.registerHttpRoute({
    path: "/friday-next-admin/models",
    handler: handleAdminModelsList,
    auth: "gateway",
    match: "exact",
  });

  // Scheduled-task (cron) management. Same sibling-prefix reasoning as above. The two
  // mutating routes need "trusted-operator" because `cron.add` / `cron.update` /
  // `cron.remove` / `cron.run` all require `operator.admin`; the run-history route does
  // NOT, since `cron.runs` only needs `operator.read` (least privilege, same call
  // commands-list makes). See handlers/cron.ts for why the app can only ever create
  // `agentTurn` jobs through this surface.
  api.registerHttpRoute({
    path: "/friday-next-admin/cron/jobs",
    handler: handleCronJobs,
    auth: "gateway",
    match: "exact",
    gatewayRuntimeScopeSurface: "trusted-operator",
  });
  api.registerHttpRoute({
    path: "/friday-next-admin/cron/jobs/run",
    handler: handleCronJobRun,
    auth: "gateway",
    match: "exact",
    gatewayRuntimeScopeSurface: "trusted-operator",
  });
  api.registerHttpRoute({
    path: "/friday-next-admin/cron/runs",
    handler: handleCronRuns,
    auth: "gateway",
    match: "exact",
  });
  // Delivery-target channel list for the cron editor's picker. Read-only like
  // `/cron/runs`: `channels.status` only needs `operator.read`, so no
  // "trusted-operator" surface here either.
  api.registerHttpRoute({
    path: "/friday-next-admin/cron/channels",
    handler: handleCronChannels,
    auth: "gateway",
    match: "exact",
  });

  // Native Talk (catalog / config / speak / mode) plus realtime session
  // (create / audio / cancel / close). Default operator surface is enough:
  // talk.catalog/config need operator.read, talk.speak/mode/session.* need
  // operator.write. Never request includeSecrets — credentials stay on Gateway.
  api.registerHttpRoute({
    path: "/friday-next-admin/talk",
    handler: handleTalk,
    auth: "gateway",
    match: "prefix",
  });

  api.logger.info("Friday Next channel HTTP routes registered at /friday-next/*");
}
