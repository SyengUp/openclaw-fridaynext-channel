/**
 * Bearer token authentication middleware for Friday HTTP routes.
 *
 * Validates that the bearer token matches the gateway's configured auth token.
 * This ensures plugin HTTP endpoints use the same token as gateway WS connections.
 */

import type { IncomingMessage } from "node:http";
import { getFridayRuntime } from "../../runtime.js";

/**
 * Extract and validate bearer token from Authorization header.
 * Returns the token only if it matches the gateway's configured auth token.
 * Returns null if token is missing, malformed, or doesn't match.
 */
export function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth || typeof auth !== "string") return null;
  const parts = auth.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") return null;
  const token = parts[1];

  // Validate token matches the gateway's configured auth token.
  const cfg = getFridayRuntime().config.loadConfig();
  const gatewayToken = cfg.gateway?.auth?.token;
  if (!gatewayToken || token !== gatewayToken) return null;

  return token;
}

/**
 * Extract deviceId from request query params.
 * Returns null if no valid deviceId is found.
 */
export function extractDeviceId(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? "/", "http://localhost");
  const queryDeviceId = url.searchParams.get("deviceId");
  if (queryDeviceId && typeof queryDeviceId === "string" && queryDeviceId.length > 0) {
    return queryDeviceId;
  }
  return null;
}
