/**
 * Bearer token authentication middleware for Friday HTTP routes.
 *
 * Validates that the bearer token matches the gateway's configured auth token.
 * This ensures plugin HTTP endpoints use the same token as gateway WS connections.
 */

import type { IncomingMessage } from "node:http";
import { resolveFridayNextConfig } from "../../config.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { getFridayNextRuntime } from "../../runtime.js";

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
  const cfg = getHostOpenClawConfigSnapshot(getFridayNextRuntime().config);
  const runtimeConfig = resolveFridayNextConfig(cfg);
  if (!runtimeConfig.authToken || token !== runtimeConfig.authToken) return null;

  return token;
}
