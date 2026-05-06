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
import { handleSessionsDelete } from "./handlers/sessions-delete.js";
import { handleStatus } from "./handlers/status.js";
import { applyCorsHeaders } from "./middleware/cors.js";
import { resolveFridayNextConfig } from "../config.js";
import { getHostOpenClawConfigSnapshot } from "../host-config.js";
import { getFridayNextRuntime } from "../runtime.js";
import { sseEmitter } from "../sse/emitter.js";

/** Route matcher - returns the matched handler or null. */
async function handleFridayNextRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
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

  if (req.method === "DELETE" && pathname === "/friday-next/sessions") {
    return await handleSessionsDelete(req, res);
  }

  if (req.method === "GET" && pathname === "/friday-next/status") {
    return await handleStatus(req, res);
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
