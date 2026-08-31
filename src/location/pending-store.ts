/**
 * In-flight location queries: SSE is pushed to the iPhone, which resolves the
 * current location and POSTs the result back. One pending request per device;
 * 20s timeout.
 * Implementation lives in the shared device-request pending store.
 */

import {
  createDeviceRequestPendingStore,
  type DeviceRequestError,
  type DeviceRequestOutcome,
} from "../device-request/pending-store.js";

export const LOCATION_QUERY_TIMEOUT_MS = 20_000;

export type LocationQueryError = DeviceRequestError;
export type LocationQueryOutcome = DeviceRequestOutcome;

const store = createDeviceRequestPendingStore({
  timeoutMs: LOCATION_QUERY_TIMEOUT_MS,
  timeoutCode: "LOCATION_TIMEOUT",
  timeoutMessage: "Timed out waiting for the iPhone to return the current location",
});

export function locationQueryBusyForDevice(deviceId: string): boolean {
  return store.busyForDevice(deviceId);
}

export function waitForLocationQueryResult(params: {
  requestId: string;
  deviceId: string;
  timeoutMs?: number;
}): Promise<LocationQueryOutcome> {
  return store.waitForResult(params);
}

export function resolveLocationQueryResult(
  requestId: string,
  outcome: LocationQueryOutcome,
): boolean {
  return store.resolveResult(requestId, outcome);
}

export function resetLocationQueryPendingStoreForTest(): void {
  store.resetForTest();
}
