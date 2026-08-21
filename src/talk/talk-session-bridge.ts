/**
 * Talk realtime session ownership for plugin HTTP routes.
 *
 * `talk.session.create({ transport: "gateway-relay" })` requires `client.connId`
 * and then `broadcastToConnIds("talk.event", …)` to that socket. Plugin HTTP
 * dispatch builds an operator client with scopes but no connId, so a naive
 * `dispatchGatewayMethod("talk.session.*")` returns UNAVAILABLE and PCM never
 * reaches `/friday-next/events`.
 *
 * This bridge:
 *   1. Stamps a synthetic `friday-talk:<deviceId>:<uuid>` onto the request-scope
 *      client before dispatch (same ALS as `dispatchGatewayMethod`).
 *   2. Wraps `context.broadcastToConnIds` once so `talk.event` frames fan out
 *      on the existing SSE stream for that device.
 *
 * iOS never opens a second operator WebSocket. Native Talk remains the fallback
 * when catalog.realtime.ready is false or create returns 503.
 */

import { randomUUID } from "node:crypto";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { sseEmitter } from "../sse/emitter.js";
import { createFridayNextLogger } from "../logging.js";
import type { TalkSdkSessionHandle } from "./talk-runtime.js";

export type TalkGatewayContext = {
  broadcastToConnIds?: (
    event: string,
    payload: unknown,
    connIds: Iterable<string> | Set<string>,
    options?: unknown,
  ) => void;
};

export type TalkSessionKind = "dispatch" | "sdk";

export type TalkSessionEntry = {
  kind: TalkSessionKind;
  deviceId: string;
  connId?: string;
  sessionKey?: string;
  handle?: TalkSdkSessionHandle;
};

const CONN_PREFIX = "friday-talk:";
const patchedContexts = new WeakSet<object>();
const sessions = new Map<string, TalkSessionEntry>();
const connIdToSessionId = new Map<string, string>();
const logger = createFridayNextLogger("talk-bridge");

export function resetTalkSessionBridgeForTest(): void {
  sessions.clear();
  connIdToSessionId.clear();
}

export function mintTalkOwnerConnId(deviceId: string): string {
  return `${CONN_PREFIX}${deviceId.trim().toUpperCase()}:${randomUUID()}`;
}

export function deviceIdFromTalkConnId(connId: string): string | undefined {
  if (!connId.startsWith(CONN_PREFIX)) return undefined;
  const rest = connId.slice(CONN_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon <= 0) return undefined;
  const deviceId = rest.slice(0, colon).trim();
  return deviceId.length > 0 ? deviceId : undefined;
}

export function rememberTalkSession(sessionId: string, entry: TalkSessionEntry): void {
  const id = sessionId.trim();
  if (!id) return;
  sessions.set(id, entry);
  if (entry.connId) connIdToSessionId.set(entry.connId, id);
}

export function forgetTalkSession(sessionId: string): void {
  const entry = sessions.get(sessionId);
  sessions.delete(sessionId);
  if (entry?.connId) connIdToSessionId.delete(entry.connId);
}

export function lookupTalkSession(sessionId: string): TalkSessionEntry | undefined {
  return sessions.get(sessionId);
}

export function attachTalkOwnerConnId(connId: string): boolean {
  const scope = getPluginRuntimeGatewayRequestScope() as
    | { client?: { connId?: string }; context?: TalkGatewayContext }
    | undefined;
  if (!scope?.client) return false;
  scope.client.connId = connId;
  if (scope.context) installTalkEventBridge(scope.context);
  return true;
}

export function installTalkEventBridge(context: TalkGatewayContext): void {
  if (typeof context.broadcastToConnIds !== "function") return;
  if (patchedContexts.has(context)) return;
  const original = context.broadcastToConnIds.bind(context);
  context.broadcastToConnIds = (event, payload, connIds, options) => {
    if (event === "talk.event") forwardTalkEvents(payload, connIds);
    return original(event, payload, connIds, options);
  };
  patchedContexts.add(context);
}

export function isLiveTalkEventType(type: unknown): boolean {
  return type === "audio" || type === "inputAudio" || type === "clear" || type === "mark";
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function connIdList(connIds: Iterable<string> | Set<string>): string[] {
  return [...connIds].filter((id) => typeof id === "string" && id.length > 0);
}

export function forwardTalkEvents(
  payload: unknown,
  connIds: Iterable<string> | Set<string>,
): void {
  const data = asRecord(payload);
  if (!data) return;
  const ids = connIdList(connIds);
  if (ids.length === 0) return;
  for (const connId of ids) {
    const sessionId =
      (typeof data.relaySessionId === "string" && data.relaySessionId.trim()) ||
      (typeof data.sessionId === "string" && data.sessionId.trim()) ||
      connIdToSessionId.get(connId);
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    const deviceId = entry?.deviceId ?? deviceIdFromTalkConnId(connId);
    if (!deviceId) continue;
    emitTalkSse(deviceId, {
      ...data,
      ...(sessionId ? { sessionId } : {}),
    });
  }
}

export function emitTalkSse(deviceId: string, data: Record<string, unknown>): void {
  const event = { type: "talk" as const, data };
  const audio = typeof data.audioBase64 === "string" ? data.audioBase64.length : 0;
  logger.info(
    `sse type=${String(data.type ?? "")} device=${deviceId} session=${String(data.sessionId ?? data.relaySessionId ?? "")} audioChars=${audio} live=${isLiveTalkEventType(data.type)}`,
  );
  if (isLiveTalkEventType(data.type)) {
    sseEmitter.broadcastLiveToDevice(event, deviceId, true);
    return;
  }
  sseEmitter.broadcast(event, deviceId, true);
}

/** Normalize `runtime.talk.openSession` callbacks (pcm Buffer) into the SSE talk payload. */
export function emitSdkTalkEvent(deviceId: string, event: Record<string, unknown>): void {
  const data: Record<string, unknown> = { ...event };
  const pcm = event.pcm;
  if (Buffer.isBuffer(pcm)) {
    data.audioBase64 = pcm.toString("base64");
    delete data.pcm;
    if (typeof data.type !== "string") data.type = "audio";
  } else if (pcm instanceof Uint8Array) {
    data.audioBase64 = Buffer.from(pcm).toString("base64");
    delete data.pcm;
    if (typeof data.type !== "string") data.type = "audio";
  }
  emitTalkSse(deviceId, data);
}
