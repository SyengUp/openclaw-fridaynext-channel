/**
 * Agent-facing Calendar/Reminders query. Transports over Friday SSE + HTTP, not OpenClaw nodes.
 */

import { randomUUID } from "node:crypto";
import { sseEmitter } from "../sse/emitter.js";
import {
  getLastRegisteredFridayDeviceId,
  resolveFridayDeviceIdForSessionKey,
} from "../friday-session.js";
import { calendarBusyForDevice, waitForCalendarResult } from "../calendar/pending-store.js";

const KINDS = ["events", "reminders"] as const;

export const CALENDAR_QUERY_TOOL_NAME = "fridaynext_calendar_query";

export const CALENDAR_QUERY_TOOL_DESCRIPTION =
  "Read Calendar events and Reminders from the user's paired FridayNext iPhone. Call this when the user asks what's on their schedule today or this week, whether they are free at some time, or what tasks are due. Returns events (title, calendar, start, end, allDay, location, notes) and reminders (title, list, dueDate, priority, isCompleted, overdue). Defaults to today 00:00 through the next 7 days; max window 31 days; limit up to 50 per kind. authorization disabledInApp means the user turned calendar reading off in FridayNext → Calendar & Reminders. The phone must be online on the Friday SSE channel. This is NOT nodes.device_health and must not go through the nodes tool. For HealthKit use fridaynext_health_query. For scheduling the agent's own future or recurring work (check-backs, periodic checks, delayed follow-ups) use the built-in cron tool, not this.";

const CalendarQueryParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    kinds: {
      type: "array",
      description:
        "Which sources to read: events (Calendar), reminders (Reminders). Omit for both.",
      items: { type: "string", enum: [...KINDS] },
    },
    start: {
      type: "string",
      description: "Inclusive ISO-8601 start. Default: today 00:00 device-local time.",
    },
    end: {
      type: "string",
      description: "Exclusive ISO-8601 end. Default: start + 7 days. Max window 31 days.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "Max items per kind. Default 20.",
    },
  },
};

function readOptionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readKinds(args: Record<string, unknown>): string[] | undefined {
  const raw = args.kinds;
  if (!Array.isArray(raw)) return undefined;
  const kinds = raw.filter(
    (item): item is (typeof KINDS)[number] => item === "events" || item === "reminders",
  );
  return kinds.length > 0 ? kinds : undefined;
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

export function createCalendarQueryTool(ctx: { sessionKey?: string }): {
  name: string;
  label: string;
  description: string;
  parameters: typeof CalendarQueryParameters;
  execute: (
    _toolCallId: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
} {
  return {
    name: CALENDAR_QUERY_TOOL_NAME,
    label: "FridayNext Calendar",
    description: CALENDAR_QUERY_TOOL_DESCRIPTION,
    parameters: CalendarQueryParameters,
    async execute(_toolCallId, args) {
      const params = args && typeof args === "object" ? args : {};
      const deviceId = resolveDeviceId(ctx.sessionKey);
      if (!deviceId) {
        return jsonToolResult({
          ok: false,
          error: {
            code: "CALENDAR_DEVICE_OFFLINE",
            message: "No FridayNext iPhone is connected",
          },
        });
      }
      if (!sseEmitter.getConnection(deviceId)) {
        return jsonToolResult({
          ok: false,
          error: {
            code: "CALENDAR_DEVICE_OFFLINE",
            message: "The FridayNext iPhone is not connected over SSE",
          },
        });
      }
      if (calendarBusyForDevice(deviceId)) {
        return jsonToolResult({
          ok: false,
          error: {
            code: "CALENDAR_BUSY",
            message: "A calendar request is already in progress on this iPhone",
          },
        });
      }

      const requestId = randomUUID();
      const kinds = readKinds(params);
      const start = readOptionalString(params, "start");
      const end = readOptionalString(params, "end");
      const limitRaw = params.limit;
      const limit =
        typeof limitRaw === "number" && Number.isInteger(limitRaw) ? limitRaw : undefined;

      const data: Record<string, unknown> = { requestId };
      if (kinds) data.kinds = kinds;
      if (start) data.start = start;
      if (end) data.end = end;
      if (limit !== undefined) data.limit = limit;

      const waiter = waitForCalendarResult({ requestId, deviceId });
      sseEmitter.broadcast({ type: "fridaynext-calendar-query", data }, deviceId, true);
      const outcome = await waiter;
      if (outcome.ok) {
        return jsonToolResult(outcome.payload);
      }
      return jsonToolResult({ ok: false, error: outcome.error });
    },
  };
}
