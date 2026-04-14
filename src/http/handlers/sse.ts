/**
 * SSE (Server-Sent Events) handler for GET /friday/events
 *
 * Establishes a persistent SSE connection for a given deviceId.
 * Events are broadcast by the SSE emitter from the agent runner.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sseEmitter } from "../../sse/emitter.js";
import { createFridaySession } from "../../session/session-manager.js";
import { extractBearerToken } from "../middleware/auth.js";

const log = (action: string, deviceId: string, detail?: string) => {
  const ts = new Date().toISOString();
  console.error(`[Friday-SSE] [${ts}] [${action}] deviceId=${deviceId}${detail ? ` detail=${detail}` : ""}`);
};

export async function handleSseStream(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  // Only allow GET
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return true;
  }

  // Validate bearer token
  const token = extractBearerToken(req);
  if (!token) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const deviceId = url.searchParams.get("deviceId") ?? "(unknown)";
    log("AUTH_FAILED", deviceId, "missing or invalid token");
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Unauthorized: missing bearer token" }));
    return true;
  }

  // Extract deviceId from query params
  const url = new URL(req.url ?? "/", "http://localhost");
  const deviceId = url.searchParams.get("deviceId");
  if (!deviceId || deviceId.trim().length === 0) {
    log("BAD_REQUEST", "(unknown)", "missing deviceId");
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing required query parameter: deviceId" }));
    return true;
  }

  log("CONNECTING", deviceId);

  // Set SSE headers
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  // Create session for this device
  createFridaySession(deviceId);

  // Register SSE connection
  const conn = sseEmitter.addConnection(deviceId, res);

  // Send initial connected event
  conn.send({
    type: "agent",
    data: { event: "connected", deviceId, timestamp: Date.now() },
  });

  log("CONNECTED", deviceId, "sent=event:connected");

  // Send keepalive every 30s
  const keepalive = setInterval(() => {
    if (conn.isClosed) {
      clearInterval(keepalive);
      return;
    }
    try {
      res.write(": keepalive\n\n");
      log("KEEPALIVE", deviceId);
    } catch {
      clearInterval(keepalive);
    }
  }, 30000);

  // Clean up on close
  req.on("close", () => {
    clearInterval(keepalive);
    sseEmitter.removeConnection(deviceId);
    log("DISCONNECTED", deviceId);
  });

  return true;
}
