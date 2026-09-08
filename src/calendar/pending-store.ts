/**
 * In-flight calendar/reminders round-trips: SSE is pushed to the iPhone,
 * which POSTs the result back. One pending calendar request per device; a suspended/killed app has
 * a full day to return. Independent of the health pending store, so a health query and a
 * calendar request can be in flight on the same device concurrently.
 */

import {
  getProcessDeviceRequestPendingStore,
  type DeviceRequestError,
  type DeviceRequestOutcome,
} from "../device-request/pending-store.js";

export const CALENDAR_REQUEST_TIMEOUT_MS = 86_400_000;

export type CalendarRequestError = DeviceRequestError;
export type CalendarRequestOutcome = DeviceRequestOutcome;

const store = getProcessDeviceRequestPendingStore("calendar", {
  timeoutMs: CALENDAR_REQUEST_TIMEOUT_MS,
  timeoutCode: "CALENDAR_TIMEOUT",
  timeoutMessage: "Timed out waiting for the iPhone to return calendar data",
});

export function calendarBusyForDevice(deviceId: string): boolean {
  return store.busyForDevice(deviceId);
}

export function hasPendingCalendarRequest(requestId: string): boolean {
  return store.hasPending(requestId);
}

export function waitForCalendarResult(params: {
  requestId: string;
  deviceId: string;
  timeoutMs?: number;
}): Promise<CalendarRequestOutcome> {
  return store.waitForResult(params);
}

export function resolveCalendarResult(requestId: string, outcome: CalendarRequestOutcome): boolean {
  return store.resolveResult(requestId, outcome);
}

export function resetCalendarPendingStoreForTest(): void {
  store.resetForTest();
}
