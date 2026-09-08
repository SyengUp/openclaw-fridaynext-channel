/**
 * In-flight device round-trips: an SSE event is pushed to the iPhone, which
 * POSTs the result back. One pending request per device per store; timeout
 * resolves with the store's error code. Health queries and calendar requests
 * each own one instance, so a health and a calendar request can be in flight
 * on the same device concurrently.
 */

export type DeviceRequestError = {
  code: string;
  message: string;
};

export type DeviceRequestOutcome =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: DeviceRequestError };

export interface DeviceRequestPendingStoreOptions {
  /** Default timeout for waitForResult. */
  timeoutMs?: number;
  /** Error code used when the iPhone never answers. */
  timeoutCode: string;
  timeoutMessage: string;
}

type Pending = {
  deviceId: string;
  resolve: (outcome: DeviceRequestOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface DeviceRequestPendingStore {
  busyForDevice(deviceId: string): boolean;
  hasPending(requestId: string): boolean;
  waitForResult(params: {
    requestId: string;
    deviceId: string;
    timeoutMs?: number;
  }): Promise<DeviceRequestOutcome>;
  resolveResult(requestId: string, outcome: DeviceRequestOutcome): boolean;
  resetForTest(): void;
}

const PROCESS_PENDING_STORES_KEY = Symbol.for(
  "@syengup/friday-channel-next/device-request-pending-stores",
);

type ProcessPendingStoreRegistry = Map<string, DeviceRequestPendingStore>;

function processPendingStoreRegistry(): ProcessPendingStoreRegistry {
  const existing = Reflect.get(globalThis, PROCESS_PENDING_STORES_KEY) as unknown;
  if (existing instanceof Map) {
    return existing as ProcessPendingStoreRegistry;
  }
  const created: ProcessPendingStoreRegistry = new Map();
  Reflect.set(globalThis, PROCESS_PENDING_STORES_KEY, created);
  return created;
}

function normalizeDeviceId(deviceId: string): string {
  return deviceId.trim().toUpperCase();
}

export function createDeviceRequestPendingStore(
  options: DeviceRequestPendingStoreOptions,
): DeviceRequestPendingStore {
  const defaultTimeoutMs = options.timeoutMs ?? 20_000;
  const byRequestId = new Map<string, Pending>();
  const requestIdByDevice = new Map<string, string>();

  return {
    busyForDevice(deviceId: string): boolean {
      return requestIdByDevice.has(normalizeDeviceId(deviceId));
    },

    hasPending(requestId: string): boolean {
      return byRequestId.has(requestId.trim());
    },

    waitForResult(params: {
      requestId: string;
      deviceId: string;
      timeoutMs?: number;
    }): Promise<DeviceRequestOutcome> {
      const requestId = params.requestId.trim();
      const deviceId = normalizeDeviceId(params.deviceId);
      const timeoutMs = params.timeoutMs ?? defaultTimeoutMs;
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
              code: options.timeoutCode,
              message: options.timeoutMessage,
            },
          });
        }, timeoutMs);
        byRequestId.set(requestId, { deviceId, resolve, timer });
        requestIdByDevice.set(deviceId, requestId);
      });
    },

    resolveResult(requestId: string, outcome: DeviceRequestOutcome): boolean {
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
    },

    resetForTest(): void {
      for (const pending of byRequestId.values()) clearTimeout(pending.timer);
      byRequestId.clear();
      requestIdByDevice.clear();
    },
  };
}

/**
 * Plugin tool discovery and full gateway registration can load separate module instances in the
 * same process. Device-result HTTP handlers must still resolve the exact waiter created by a tool
 * instance, otherwise the old instance keeps its per-device busy lock until the long timeout.
 */
export function getProcessDeviceRequestPendingStore(
  key: string,
  options: DeviceRequestPendingStoreOptions,
): DeviceRequestPendingStore {
  const normalizedKey = key.trim();
  if (!normalizedKey) throw new Error("pending store key is required");
  const registry = processPendingStoreRegistry();
  const existing = registry.get(normalizedKey);
  if (existing) return existing;
  const created = createDeviceRequestPendingStore(options);
  registry.set(normalizedKey, created);
  return created;
}
