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
import { handleHistoryMessages } from "./handlers/history-messages.js";
import { handleHistorySetTitle } from "./handlers/history-set-title.js";
import { handleStatus } from "./handlers/status.js";
import { handleLinkPreview } from "./handlers/link-preview.js";
import { handleHealth } from "./handlers/health.js";
import { handlePluginInfo } from "./handlers/plugin-info.js";
import { handlePluginUpgrade } from "./handlers/plugin-upgrade.js";
import { applyCorsHeaders } from "./middleware/cors.js";
import { resolveFridayNextConfig } from "../config.js";
import { getHostOpenClawConfigSnapshot } from "../host-config.js";
import { getFridayNextRuntime } from "../runtime.js";
import { sseEmitter } from "../sse/emitter.js";

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

  api.logger.info("Friday Next channel HTTP routes registered at /friday-next/*");
}
