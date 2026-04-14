/**
 * HTTP server registration for the Friday channel.
 *
 * Registers routes on the gateway HTTP server under the /friday/ path prefix.
 * Routes are registered via the plugin API's registerHttpRoute method.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { handleMessages } from "./handlers/messages.js";
import { handleSseStream } from "./handlers/sse.js";
import { handleFilesUpload } from "./handlers/files-upload.js";
import { handleFilesDownload } from "./handlers/files-download.js";
import { handleHistory } from "./handlers/history.js";

/** Route matcher - returns the matched handler or null. */
async function handleFridayRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  // Route: GET /friday/events?deviceId=...
  if (req.method === "GET" && pathname === "/friday/events") {
    return await handleSseStream(req, res);
  }

  // Route: POST /friday/messages
  if (req.method === "POST" && pathname === "/friday/messages") {
    return await handleMessages(req, res);
  }

  // Route: GET/DELETE /friday/history?deviceId=...
  if ((req.method === "GET" || req.method === "DELETE") && pathname === "/friday/history") {
    return await handleHistory(req, res);
  }

  // Route: POST /friday/files (multipart upload)
  if (req.method === "POST" && pathname === "/friday/files") {
    return await handleFilesUpload(req, res);
  }

  // Route: GET /friday/files/:id (download)
  if (req.method === "GET" && pathname.startsWith("/friday/files/")) {
    return await handleFilesDownload(req, res);
  }

  // Not found
  return false;
}

export function registerFridayHttpRoutes(api: OpenClawPluginApi): void {
  // Plugin handles its own auth via extractBearerToken()
  api.registerHttpRoute({
    path: "/friday",
    handler: handleFridayRoute,
    auth: "plugin",
    match: "prefix",
  });

  api.logger.info("Friday channel HTTP routes registered at /friday/*");
}
