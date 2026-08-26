/**
 * In-flight HealthKit queries: SSE is pushed to the iPhone, which POSTs the
 * result back. One pending request per device; 20s timeout.
 */

export const HEALTH_QUERY_TIMEOUT_MS = 20_000;

export type HealthQueryError = {
  code: string;
  message: string;
};

export type HealthQueryOutcome =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: HealthQueryError };

type Pending = {
  deviceId: string;
  resolve: (outcome: HealthQueryOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
};

const byRequestId = new Map<string, Pending>();
const requestIdByDevice = new Map<string, string>();

function normalizeDeviceId(deviceId: string): string {
  return deviceId.trim().toUpperCase();
}

export function healthQueryBusyForDevice(deviceId: string): boolean {
  return requestIdByDevice.has(normalizeDeviceId(deviceId));
}

export function waitForHealthQueryResult(params: {
  requestId: string;
  deviceId: string;
  timeoutMs?: number;
}): Promise<HealthQueryOutcome> {
  const requestId = params.requestId.trim();
  const deviceId = normalizeDeviceId(params.deviceId);
  const timeoutMs = params.timeoutMs ?? HEALTH_QUERY_TIMEOUT_MS;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const pending = byRequestId.get(requestId);
      if (!pending) return;
      byRequestId.delete(requestId);
      if (requestIdByDevice.get(pending.deviceId) === requestId) {
        requestIdByDevice.delete(pending.deviceId);
      }
      pending.resolve({
        ok: false,
        error: {
          code: "HEALTH_TIMEOUT",
          message: "Timed out waiting for the iPhone to return HealthKit data",
        },
      });
    }, timeoutMs);
    byRequestId.set(requestId, { deviceId, resolve, timer });
    requestIdByDevice.set(deviceId, requestId);
  });
}

export function resolveHealthQueryResult(
  requestId: string,
  outcome: HealthQueryOutcome,
): boolean {
  const id = requestId.trim();
  const pending = byRequestId.get(id);
  if (!pending) return false;
  clearTimeout(pending.timer);
  byRequestId.delete(id);
  if (requestIdByDevice.get(pending.deviceId) === id) {
    requestIdByDevice.delete(pending.deviceId);
  }
  pending.resolve(outcome);
  return true;
}

export function resetHealthQueryPendingStoreForTest(): void {
  for (const pending of byRequestId.values()) clearTimeout(pending.timer);
  byRequestId.clear();
  requestIdByDevice.clear();
}
