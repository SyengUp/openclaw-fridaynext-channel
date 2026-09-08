/**
 * In-flight HealthKit queries: SSE is pushed to the iPhone, which POSTs the
 * result back. One pending request per device; the long bound lets a suspended/killed app return.
 * Implementation lives in the shared device-request pending store.
 */

import {
  getProcessDeviceRequestPendingStore,
  type DeviceRequestError,
  type DeviceRequestOutcome,
} from "../device-request/pending-store.js";

export const HEALTH_QUERY_TIMEOUT_MS = 86_400_000;

export type HealthQueryError = DeviceRequestError;
export type HealthQueryOutcome = DeviceRequestOutcome;

const store = getProcessDeviceRequestPendingStore("health", {
  timeoutMs: HEALTH_QUERY_TIMEOUT_MS,
  timeoutCode: "HEALTH_TIMEOUT",
  timeoutMessage: "Timed out waiting for the iPhone to return HealthKit data",
});

export function healthQueryBusyForDevice(deviceId: string): boolean {
  return store.busyForDevice(deviceId);
}

export function hasPendingHealthQuery(requestId: string): boolean {
  return store.hasPending(requestId);
}

export function waitForHealthQueryResult(params: {
  requestId: string;
  deviceId: string;
  timeoutMs?: number;
}): Promise<HealthQueryOutcome> {
  return store.waitForResult(params);
}

export function resolveHealthQueryResult(requestId: string, outcome: HealthQueryOutcome): boolean {
  return store.resolveResult(requestId, outcome);
}

export function resetHealthQueryPendingStoreForTest(): void {
  store.resetForTest();
}
