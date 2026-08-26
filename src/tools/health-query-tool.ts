/**
 * Agent-facing HealthKit query. Transports over Friday SSE + HTTP, not OpenClaw nodes.
 */

import { randomUUID } from "node:crypto";
import { sseEmitter } from "../sse/emitter.js";
import {
  getLastRegisteredFridayDeviceId,
  resolveFridayDeviceIdForSessionKey,
} from "../friday-session.js";
import {
  healthQueryBusyForDevice,
  waitForHealthQueryResult,
} from "../health-query/pending-store.js";
import { QUERY_METRIC_IDS } from "./health-metrics.js";

const BUCKETS = ["none", "hour", "day"] as const;

export const HEALTH_QUERY_TOOL_NAME = "fridaynext_health_query";

export const HEALTH_QUERY_TOOL_DESCRIPTION =
  "Read aggregated Apple Health (HealthKit) summaries from the user's paired FridayNext iPhone. Covers activity (steps, walking/cycling/swimming distance, active and basal energy, exercise/stand time, flights), sleep stages, heart (rate, resting, walking average, HRV, VO2 max), workouts, body (mass, lean mass, fat, BMI, height, waist), mindful minutes, and the full HealthKit nutrition set (water, energy, macros, caffeine, fiber, sugar, cholesterol, vitamins, minerals). Call this when the user asks about health, fitness, sleep, diet, caffeine, or coaching based on recent Health data. Do not invent metrics that were not returned. To write diet (including caffeine), body measurements, or mindfulness into Health, use fridaynext_health_log. authorization disabledInApp means the user turned that category off in FridayNext → Health Data. noData means the query ran but HealthKit returned no samples. sharingAuthorized means samples were read. The phone must be online on the Friday SSE channel. Defaults to the last 24 hours; max window 31 days. This is NOT nodes.device_health and must not go through the nodes tool.";

const HealthQueryParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    metrics: {
      type: "array",
      description: `Subset of metrics to read. Omit to read every category the user enabled in FridayNext. Allowed: ${QUERY_METRIC_IDS.join(", ")}.`,
      items: { type: "string", enum: [...QUERY_METRIC_IDS] },
    },
    start: {
      type: "string",
      description: "Inclusive ISO-8601 start. Omit with end for the last 24 hours.",
    },
    end: {
      type: "string",
      description: "Exclusive ISO-8601 end. Omit with start for the last 24 hours.",
    },
    bucket: {
      type: "string",
      enum: [...BUCKETS],
      description: "Aggregation bucket. Default day. Use none for a single total.",
    },
  },
};

function readOptionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readMetrics(args: Record<string, unknown>): string[] | undefined {
  const raw = args.metrics;
  if (!Array.isArray(raw)) return undefined;
  const metrics = raw.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return metrics.length > 0 ? metrics : undefined;
}

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

export function createHealthQueryTool(ctx: { sessionKey?: string }): {
  name: string;
  label: string;
  description: string;
  parameters: typeof HealthQueryParameters;
  execute: (
    _toolCallId: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
} {
  return {
    name: HEALTH_QUERY_TOOL_NAME,
    label: "FridayNext Health",
    description: HEALTH_QUERY_TOOL_DESCRIPTION,
    parameters: HealthQueryParameters,
    async execute(_toolCallId, args) {
      const params = args && typeof args === "object" ? args : {};
      const deviceId = resolveDeviceId(ctx.sessionKey);
      if (!deviceId) {
        return jsonToolResult({
          ok: false,
          error: {
            code: "HEALTH_DEVICE_OFFLINE",
            message: "No FridayNext iPhone is connected",
          },
        });
      }
      if (!sseEmitter.getConnection(deviceId)) {
        return jsonToolResult({
          ok: false,
          error: {
            code: "HEALTH_DEVICE_OFFLINE",
            message: "The FridayNext iPhone is not connected over SSE",
          },
        });
      }
      if (healthQueryBusyForDevice(deviceId)) {
        return jsonToolResult({
          ok: false,
          error: {
            code: "HEALTH_BUSY",
            message: "A health query is already in progress on this iPhone",
          },
        });
      }

      const requestId = randomUUID();
      const metrics = readMetrics(params);
      const start = readOptionalString(params, "start");
      const end = readOptionalString(params, "end");
      const bucketRaw = readOptionalString(params, "bucket");
      const bucket =
        bucketRaw === "none" || bucketRaw === "hour" || bucketRaw === "day" ? bucketRaw : undefined;

      const data: Record<string, unknown> = { requestId };
      if (metrics) data.metrics = metrics;
      if (start) data.start = start;
      if (end) data.end = end;
      if (bucket) data.bucket = bucket;

      const waiter = waitForHealthQueryResult({ requestId, deviceId });
      sseEmitter.broadcast({ type: "fridaynext-health-query", data }, deviceId, true);
      const outcome = await waiter;
      if (outcome.ok) {
        return jsonToolResult(outcome.payload);
      }
      return jsonToolResult({ ok: false, error: outcome.error });
    },
  };
}
