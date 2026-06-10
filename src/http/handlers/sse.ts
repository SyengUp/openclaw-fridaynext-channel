import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveFridayNextConfig } from "../../config.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { getFridayNextRuntime } from "../../runtime.js";
import { sseEmitter } from "../../sse/emitter.js";
import { extractBearerToken } from "../middleware/auth.js";
import { PLUGIN_VERSION } from "../../version.js";

function parseLastEventId(req: IncomingMessage, url: URL): number {
  const query = Number.parseInt(url.searchParams.get("lastEventId") ?? "", 10);
  if (Number.isFinite(query)) return query;
  const header = Number.parseInt((req.headers["last-event-id"] as string) ?? "", 10);
  return Number.isFinite(header) ? header : 0;
}

export async function handleSseStream(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return true;
  }

  const token = extractBearerToken(req);
  if (!token) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Unauthorized: bearer token mismatch" }));
    return true;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const deviceId = (url.searchParams.get("deviceId") ?? "").trim();
  if (!deviceId) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing required query parameter: deviceId" }));
    return true;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.flushHeaders();

  const conn = sseEmitter.addConnection(deviceId, res);

  const normalized = deviceId.trim().toUpperCase();
  const lastSeq = sseEmitter.latestSeqForDevice(normalized);
  sseEmitter.broadcast(
    {
      type: "connected",
      data: {
        deviceId: normalized,
        serverTime: Date.now(),
        lastSeq,
        pluginVersion: PLUGIN_VERSION,
      },
    },
    deviceId,
    true,
  );

  const lastEventId = parseLastEventId(req, url);
  if (lastEventId > 0) sseEmitter.replayBacklog(deviceId, lastEventId);

  const config = resolveFridayNextConfig(getHostOpenClawConfigSnapshot(getFridayNextRuntime().config));
  const keepalive = setInterval(() => {
    if (conn.isClosed) {
      clearInterval(keepalive);
      return;
    }
    conn.sendRaw(": keepalive\n\n");
  }, config.sseKeepaliveSec * 1000);
  keepalive.unref();

  req.on("close", () => {
    clearInterval(keepalive);
    sseEmitter.removeConnection(deviceId, conn);
  });

  return true;
}
