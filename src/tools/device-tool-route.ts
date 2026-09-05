import { resolveFridayDeviceIdForSessionKey } from "../friday-session.js";
import { getRuntimeV3Store, runtimeV3StoreIfInitialized } from "../runtime-v3/runtime-store.js";

export type DeviceToolRoute = {
  deviceId: string;
  sessionKey: string;
  runId?: string;
};

/** Device tools require an explicit OpenClaw session context and its persisted device mapping.
 * Never fall back to the last/sole connected phone: that can route a result into another session. */
export function resolveDeviceToolRoute(sessionKey: string | undefined): DeviceToolRoute | null {
  const normalizedSessionKey = sessionKey?.trim() ?? "";
  if (!normalizedSessionKey) return null;
  const mapped = resolveFridayDeviceIdForSessionKey(normalizedSessionKey);
  if (!mapped) return null;
  const deviceId = mapped.trim().toUpperCase();
  if (!deviceId) return null;
  const runId = runtimeV3StoreIfInitialized()
    ?.activeRunForSession(normalizedSessionKey, deviceId)
    ?.runId;
  return {
    deviceId,
    sessionKey: normalizedSessionKey,
    ...(runId ? { runId } : {}),
  };
}

export function registerDeviceToolRequest(
  route: DeviceToolRoute,
  kind: "health" | "calendar" | "location",
  sourceEventType:
    | "fridaynext-health-query"
    | "fridaynext-health-log"
    | "fridaynext-calendar-query"
    | "fridaynext-calendar-log"
    | "fridaynext-location-query",
  requestId: string,
  payload: unknown,
): void {
  getRuntimeV3Store().registerDeviceRequest({
    kind,
    requestId,
    deviceId: route.deviceId,
    sessionKey: route.sessionKey,
    runId: route.runId,
    sourceEventType,
    payload,
  });
}

export function completeDeviceToolRequest(
  kind: "health" | "calendar" | "location",
  requestId: string,
): void {
  getRuntimeV3Store().completeDeviceRequest(kind, requestId);
}
