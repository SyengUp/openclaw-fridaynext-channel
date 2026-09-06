/**
 * Agent-facing HealthKit write. Same SSE + HTTP transport as query, not nodes.
 */

import { randomUUID } from "node:crypto";
import { sseEmitter } from "../sse/emitter.js";
import {
  healthQueryBusyForDevice,
  waitForHealthQueryResult,
} from "../health-query/pending-store.js";
import { WRITABLE_METRIC_IDS } from "./health-metrics.js";
import {
  completeDeviceToolRequest,
  deviceOnlineForToolRequests,
  registerDeviceToolRequest,
  resolveDeviceToolRoute,
} from "./device-tool-route.js";

export const HEALTH_LOG_TOOL_NAME = "fridaynext_health_log";

export const HEALTH_LOG_TOOL_DESCRIPTION =
  "Write samples into Apple Health on the user's paired FridayNext iPhone. Use this to log food, water, caffeine, calories, macros, fiber, sugar, cholesterol, vitamins, minerals, weight, lean mass, waist, height, BMI, body fat, or a mindfulness session. Requires FridayNext → Health Data → enable read AND the separate write toggle, plus the iOS Health write permission. Do not write steps, sleep, heart rate, VO2 max, or workouts. Call fridaynext_health_query afterwards if you need to confirm. Phone must be online on Friday SSE. This is NOT nodes and not a read tool.";

const HealthLogParameters = {
  type: "object",
  additionalProperties: false,
  required: ["samples"],
  properties: {
    samples: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      description: `One Health sample per entry. Allowed metric: ${WRITABLE_METRIC_IDS.join(", ")}. Default units: water mL, energy kcal, macros/fiber/sugar/fats g, caffeine/sodium/minerals mg, vitamins A/D/K/B12/folate µg, bodyMass kg, bodyFat 0-1 or 0-100 with unit %, height/waist m (or cm), bmi count, mindfulMinutes min.`,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["metric", "value"],
        properties: {
          metric: { type: "string", enum: [...WRITABLE_METRIC_IDS] },
          value: { type: "number", description: "Non-negative amount in `unit`." },
          unit: { type: "string", description: "Optional. Examples: mL, L, kcal, kJ, g, kg, lb, %, cm, m, min." },
          at: { type: "string", description: "Optional ISO-8601 timestamp. Default now." },
        },
      },
    },
  },
};

function jsonToolResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function readSamples(args: Record<string, unknown>): Array<{
  metric: string;
  value: number;
  unit?: string;
  at?: string;
}> | null {
  const raw = args.samples;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const samples: Array<{ metric: string; value: number; unit?: string; at?: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const metric = typeof row.metric === "string" ? row.metric.trim() : "";
    const value = typeof row.value === "number" ? row.value : Number(row.value);
    if (!metric || !Number.isFinite(value)) return null;
    const sample: { metric: string; value: number; unit?: string; at?: string } = { metric, value };
    if (typeof row.unit === "string" && row.unit.trim()) sample.unit = row.unit.trim();
    if (typeof row.at === "string" && row.at.trim()) sample.at = row.at.trim();
    samples.push(sample);
  }
  return samples.length > 0 ? samples : null;
}

export function createHealthLogTool(ctx: { sessionKey?: string }): {
  name: string;
  label: string;
  description: string;
  parameters: typeof HealthLogParameters;
  execute: (
    _toolCallId: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
} {
  return {
    name: HEALTH_LOG_TOOL_NAME,
    label: "FridayNext Health Log",
    description: HEALTH_LOG_TOOL_DESCRIPTION,
    parameters: HealthLogParameters,
    async execute(_toolCallId, args) {
      const params = args && typeof args === "object" ? args : {};
      const samples = readSamples(params);
      if (!samples) {
        return jsonToolResult({
          ok: false,
          error: {
            code: "HEALTH_INVALID_SAMPLE",
            message: "samples must be a non-empty array of {metric, value}",
          },
        });
      }
      const route = resolveDeviceToolRoute(ctx.sessionKey);
      if (!route) {
        return jsonToolResult({
          ok: false,
          error: {
            code: "HEALTH_DEVICE_OFFLINE",
            message: "No FridayNext iPhone is connected",
          },
        });
      }
      const { deviceId } = route;
      if (!deviceOnlineForToolRequests(deviceId)) {
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
            message: "A health request is already in progress on this iPhone",
          },
        });
      }

      const requestId = randomUUID();
      const data: Record<string, unknown> = {
        requestId,
        samples,
        sessionKey: route.sessionKey,
        ...(route.runId ? { runId: route.runId } : {}),
      };
      registerDeviceToolRequest(route, "health", "fridaynext-health-log", requestId, data);
      const waiter = waitForHealthQueryResult({ requestId, deviceId });
      sseEmitter.broadcast(
        { type: "fridaynext-health-log", data },
        deviceId,
        true,
      );
      const outcome = await waiter;
      completeDeviceToolRequest("health", requestId);
      if (outcome.ok) {
        return jsonToolResult(outcome.payload);
      }
      return jsonToolResult({ ok: false, error: outcome.error });
    },
  };
}
