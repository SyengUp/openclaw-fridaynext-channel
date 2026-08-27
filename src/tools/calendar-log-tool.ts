/**
 * Agent-facing Calendar/Reminders create. Same SSE + HTTP transport as query, not nodes.
 */

import { randomUUID } from "node:crypto";
import { sseEmitter } from "../sse/emitter.js";
import {
  getLastRegisteredFridayDeviceId,
  resolveFridayDeviceIdForSessionKey,
} from "../friday-session.js";
import { calendarBusyForDevice, waitForCalendarResult } from "../calendar/pending-store.js";

export const CALENDAR_LOG_TOOL_NAME = "fridaynext_calendar_log";

export const CALENDAR_LOG_TOOL_DESCRIPTION =
  'Create Calendar events and Reminders on the user\'s paired FridayNext iPhone. Pick the kind by what the user asked for: kind="event" for anything that occupies a time range or happens at a time — meetings, appointments, classes, flights, doctor visits; kind="reminder" for a to-do with at most a deadline — buy groceries, reply to email, submit the report. For work the AGENT itself must do later or on a schedule ("check the deployment in two hours", "send me a daily summary") use the built-in cron tool instead. When the user says "remind me to X at T": if X is an activity with duration, attendees, or a location (a meeting, a class), create an event at T with alarmMinutesBefore; if X is a plain action with no duration, create a reminder with dueDate T and an alarm. Events need start (ISO-8601 with timezone; end defaults to start + 1 hour; allDay events accept a bare YYYY-MM-DD date and end defaults to the next day). Reminders take an optional dueDate and priority. alarmMinutesBefore (minutes, 0 = no alarm, max 20160 = 14 days) applies to both kinds and is how you honor "remind me" — suggest 15 for meetings. No recurring items; recurring agent work belongs to cron. Writes go to the default calendar and default reminder list the user chose in FridayNext → Calendar & Reminders; never ask which calendar and never claim to have picked one. Requires that page\'s read toggle AND the separate write toggle, plus the iOS Calendar/Reminders permission; the app never modifies or deletes existing events. Call fridaynext_calendar_query afterwards to confirm. Phone must be online on Friday SSE. This is NOT nodes and not a read tool — reading is fridaynext_calendar_query.';

const CalendarLogParameters = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      description:
        'One entry per event/reminder. kind is "event" (Calendar) or "reminder" (Reminders).',
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "title"],
        properties: {
          kind: { type: "string", enum: ["event", "reminder"] },
          title: { type: "string", description: "1-200 chars." },
          notes: { type: "string", description: "Optional, max 2000 chars." },
          start: {
            type: "string",
            description:
              "Event only. ISO-8601 with timezone offset; allDay events may use a bare YYYY-MM-DD date. Required unless allDay.",
          },
          end: {
            type: "string",
            description: "Event only. Default: start + 1 hour (allDay: next day).",
          },
          allDay: { type: "boolean", description: "Event only. Bare-date start allowed." },
          location: { type: "string", description: "Event only, max 200 chars." },
          dueDate: {
            type: "string",
            description:
              "Reminder only. ISO-8601 or bare YYYY-MM-DD. Omit only when the user gave no time at all.",
          },
          priority: {
            type: "string",
            enum: ["none", "low", "medium", "high"],
            description: "Reminder only. Default none.",
          },
          alarmMinutesBefore: {
            type: "integer",
            minimum: 0,
            maximum: 20160,
            description: "Alarm offset in minutes. 0 = no alarm. Max 14 days.",
          },
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

function resolveDeviceId(sessionKey: string | undefined): string | null {
  const sk = sessionKey?.trim() ?? "";
  if (sk) {
    const mapped = resolveFridayDeviceIdForSessionKey(sk);
    if (mapped) return mapped;
  }
  return sseEmitter.getSoleConnectedDeviceId() ?? getLastRegisteredFridayDeviceId() ?? null;
}

type CalendarLogItemWire = {
  kind: "event" | "reminder";
  title: string;
  notes?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  dueDate?: string;
  priority?: string;
  alarmMinutesBefore?: number;
};

function readItems(args: Record<string, unknown>): CalendarLogItemWire[] | null {
  const raw = args.items;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const items: CalendarLogItemWire[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const kind = row.kind === "event" || row.kind === "reminder" ? row.kind : null;
    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (!kind || !title) return null;
    const entry: CalendarLogItemWire = { kind, title };
    if (typeof row.notes === "string" && row.notes.trim()) entry.notes = row.notes.trim();
    if (typeof row.start === "string" && row.start.trim()) entry.start = row.start.trim();
    if (typeof row.end === "string" && row.end.trim()) entry.end = row.end.trim();
    if (typeof row.allDay === "boolean") entry.allDay = row.allDay;
    if (typeof row.location === "string" && row.location.trim()) {
      entry.location = row.location.trim();
    }
    if (typeof row.dueDate === "string" && row.dueDate.trim()) {
      entry.dueDate = row.dueDate.trim();
    }
    if (typeof row.priority === "string" && row.priority.trim()) {
      entry.priority = row.priority.trim();
    }
    if (typeof row.alarmMinutesBefore === "number" && Number.isFinite(row.alarmMinutesBefore)) {
      entry.alarmMinutesBefore = row.alarmMinutesBefore;
    }
    items.push(entry);
  }
  return items.length > 0 ? items : null;
}

export function createCalendarLogTool(ctx: { sessionKey?: string }): {
  name: string;
  label: string;
  description: string;
  parameters: typeof CalendarLogParameters;
  execute: (
    _toolCallId: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
} {
  return {
    name: CALENDAR_LOG_TOOL_NAME,
    label: "FridayNext Calendar Log",
    description: CALENDAR_LOG_TOOL_DESCRIPTION,
    parameters: CalendarLogParameters,
    async execute(_toolCallId, args) {
      const params = args && typeof args === "object" ? args : {};
      const items = readItems(params);
      if (!items) {
        return jsonToolResult({
          ok: false,
          error: {
            code: "CALENDAR_INVALID_ITEM",
            message: "items must be a non-empty array of {kind: event|reminder, title}",
          },
        });
      }
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
      const waiter = waitForCalendarResult({ requestId, deviceId });
      sseEmitter.broadcast(
        { type: "fridaynext-calendar-log", data: { requestId, items } },
        deviceId,
        true,
      );
      const outcome = await waiter;
      if (outcome.ok) {
        return jsonToolResult(outcome.payload);
      }
      return jsonToolResult({ ok: false, error: outcome.error });
    },
  };
}
