/**
 * In-flight HealthKit queries: SSE is pushed to the iPhone, which POSTs the
 * result back. One pending request per device; 20s timeout.
 * Implementation lives in the shared device-request pending store.
 */

import {
  createDeviceRequestPendingStore,
  type DeviceRequestError,
  type DeviceRequestOutcome,
} from "../device-request/pending-store.js";

export const HEALTH_QUERY_TIMEOUT_MS = 20_000;

export type HealthQueryError = DeviceRequestError;
export type HealthQueryOutcome = DeviceRequestOutcome;

const store = createDeviceRequestPendingStore({
  timeoutMs: HEALTH_QUERY_TIMEOUT_MS,
  timeoutCode: "HEALTH_TIMEOUT",
  timeoutMessage: "Timed out waiting for the iPhone to return HealthKit data",
});

export function healthQueryBusyForDevice(deviceId: string): boolean {
  return store.busyForDevice(deviceId);
}

export function waitForHealthQueryResult(params: {
  requestId: string;
  deviceId: string;
  timeoutMs?: number;
}): Promise<HealthQueryOutcome> {
  return store.waitForResult(params);
}

export function resolveHealthQueryResult(
  requestId: string,
  outcome: HealthQueryOutcome,
): boolean {
  return store.resolveResult(requestId, outcome);
}

export function resetHealthQueryPendingStoreForTest(): void {
  store.resetForTest();
}
