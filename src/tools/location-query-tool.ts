/**
 * Agent-facing location query. Transports over Friday SSE + HTTP, not OpenClaw nodes.
 * The iPhone resolves the current location through its sharing toggle / system
 * permission gates, then POSTs the result back once — no continuous tracking.
 */

import { randomUUID } from "node:crypto";
import { sseEmitter } from "../sse/emitter.js";
import {
  getLastRegisteredFridayDeviceId,
  resolveFridayDeviceIdForSessionKey,
} from "../friday-session.js";
import {
  locationQueryBusyForDevice,
  waitForLocationQueryResult,
} from "../location/pending-store.js";

export const LOCATION_QUERY_TOOL_NAME = "fridaynext_location_query";

export const LOCATION_QUERY_TOOL_DESCRIPTION =
  "Read the current location of the user's paired FridayNext iPhone once. Call this when the user asks where they are or when a location is needed (weather, directions, timezone, proximity). Returns latitude, longitude, horizontalAccuracy (meters) and timestampMs; no history and no continuous tracking — each call reads one location. authorization disabled means the user turned location off in FridayNext; sharingAuthorized means the read went through. The phone must be online on the Friday SSE channel. This is NOT nodes.device_health and must not go through the nodes tool.";

const LocationQueryParameters = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

function jsonToolResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function resolveDeviceId(sessionKey: string | undefined): string | null {
  const sk = sessionKey?.trim() ?? "";
  if (sk) {
    const mapped = resolveFridayDeviceIdForSessionKey(sk);
    if (mapped) return mapped;
  }
  return sseEmitter.getSoleConnectedDeviceId() ?? getLastRegisteredFridayDeviceId() ?? null;
}

export function createLocationQueryTool(ctx: { sessionKey?: string }): {
  name: string;
  label: string;
  description: string;
  parameters: typeof LocationQueryParameters;
  execute: (
    _toolCallId: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
} {
  return {
    name: LOCATION_QUERY_TOOL_NAME,
    label: "FridayNext Location",
    description: LOCATION_QUERY_TOOL_DESCRIPTION,
    parameters: LocationQueryParameters,
    async execute(_toolCallId, args) {
      void args;
      const deviceId = resolveDeviceId(ctx.sessionKey);
      if (!deviceId) {
        return jsonToolResult({
          ok: false,
          error: {
            code: "LOCATION_DEVICE_OFFLINE",
            message: "No FridayNext iPhone is connected",
          },
        });
      }
      if (!sseEmitter.getConnection(deviceId)) {
        return jsonToolResult({
          ok: false,
          error: {
            code: "LOCATION_DEVICE_OFFLINE",
            message: "The FridayNext iPhone is not connected over SSE",
          },
        });
      }
      if (locationQueryBusyForDevice(deviceId)) {
        return jsonToolResult({
          ok: false,
          error: {
            code: "LOCATION_BUSY",
            message: "A location query is already in progress on this iPhone",
          },
        });
      }

      const requestId = randomUUID();
      const data: Record<string, unknown> = { requestId };

      const waiter = waitForLocationQueryResult({ requestId, deviceId });
      sseEmitter.broadcast({ type: "fridaynext-location-query", data }, deviceId, true);
      const outcome = await waiter;
      if (outcome.ok) {
        return jsonToolResult(outcome.payload);
      }
      return jsonToolResult({ ok: false, error: outcome.error });
    },
  };
}
