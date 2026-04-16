import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sseEmitter } from "./sse/emitter.js";
import { toSessionStoreKey } from "./session/session-manager.js";
import { getOpenClawAgentRunContext } from "./agent-run-context-bridge.js";
import { appendLateAssistantText, appendLateReasoningDelta } from "./conversation-history.js";

/** Keep in sync with `conversation-history.ts` HISTORY_DIR. */
const FRIDAY_HISTORY_DIR = path.join(
  os.homedir(),
  ".openclaw",
  "agents",
  "main",
  "sessions",
  "friday-history",
);

/** Parse deviceId from a Friday channel sessionKey (friday-{deviceId} or legacy agent:main:friday-*). */
export function deviceIdFromSessionKey(sessionKey: string): string | null {
  const m1 = sessionKey.match(/^friday-(.+)$/i);
  if (m1) return m1[1] ?? null;
  const m2 = sessionKey.match(/^agent:main:friday-(.+)$/i);
  return m2 ? m2[1] ?? null : null;
}

/**
 * When the app uses a plain `sessionKey` (e.g. `main` → `agent:main:main` in the gateway),
 * sub-agent / announce runs still emit `onAgentEvent` with that store key — not `friday-{deviceId}`.
 * Each POST /friday/messages registers both the raw and store keys so forwards and tool hooks resolve.
 */
const sessionKeyToDeviceId = new Map<string, string>();
/** Gateway / store session keys → app's history `sessionKey` (verbatim from POST). */
const gatewayKeyToHistorySessionKey = new Map<string, string>();
/** deviceId → latest app history sessionKey (verbatim from POST). */
const deviceIdToLatestHistorySessionKey = new Map<string, string>();
/** Last device that called POST /friday/messages (same gateway process). Used for cron/outbound when `to` is placeholder and the app is offline (no SSE). */
let lastRegisteredFridayDeviceId: string | undefined;

function normalizeFridaySessionKeyCase(sk: string): string {
  return /^friday-|^agent:main:friday-/i.test(sk) ? sk.toLowerCase() : sk;
}

export function registerFridaySessionDeviceMapping(
  rawSessionKey: string,
  deviceId: string,
): void {
  const sk = rawSessionKey.trim();
  const did = deviceId.trim().toUpperCase();
  if (!sk || !did) return;
  const storeKey = toSessionStoreKey(sk);
  for (const k of new Set([
    sk,
    storeKey,
    normalizeFridaySessionKeyCase(sk),
    normalizeFridaySessionKeyCase(storeKey),
  ])) {
    sessionKeyToDeviceId.set(k, did);
    gatewayKeyToHistorySessionKey.set(k, sk);
  }
  deviceIdToLatestHistorySessionKey.set(did, sk);
  lastRegisteredFridayDeviceId = did;
}

/** In-process fallback for tool hooks / telemetry (same idea as outbound sole-device). */
export function getLastRegisteredFridayDeviceId(): string | undefined {
  return lastRegisteredFridayDeviceId;
}

/** Resolve device for gateway `sessionKey` (friday-style or last POST mapping). */
export function resolveFridayDeviceIdForSessionKey(sessionKey: string): string | null {
  // Prefer last POST /friday/messages mapping first. Keys like `agent:main:friday-ios` also match
  // legacy `agent:main:friday-(.+)` and would wrongly yield deviceId "ios" instead of the real UUID.
  const mapped =
    sessionKeyToDeviceId.get(sessionKey) ??
    sessionKeyToDeviceId.get(toSessionStoreKey(sessionKey)) ??
    sessionKeyToDeviceId.get(normalizeFridaySessionKeyCase(sessionKey)) ??
    sessionKeyToDeviceId.get(normalizeFridaySessionKeyCase(toSessionStoreKey(sessionKey)));
  if (mapped) return mapped;
  return deviceIdFromSessionKey(sessionKey);
}

function historySessionKeyForGatewaySessionKey(sk: string): string | undefined {
  return (
    gatewayKeyToHistorySessionKey.get(sk) ??
    gatewayKeyToHistorySessionKey.get(toSessionStoreKey(sk)) ??
    gatewayKeyToHistorySessionKey.get(normalizeFridaySessionKeyCase(sk)) ??
    gatewayKeyToHistorySessionKey.get(normalizeFridaySessionKeyCase(toSessionStoreKey(sk)))
  );
}

/** Tool hooks / core may pass gateway store keys; history files use the app's POST sessionKey. */
export function resolveFridayHistorySessionKey(gatewaySessionKey: string): string | undefined {
  const sk = gatewaySessionKey.trim();
  if (!sk) return undefined;
  return historySessionKeyForGatewaySessionKey(sk);
}

/** Resolve latest known app history sessionKey by deviceId. */
export function latestHistorySessionKeyForDeviceId(deviceId: string): string | undefined {
  return deviceIdToLatestHistorySessionKey.get(deviceId.trim().toUpperCase());
}

/**
 * History file key for outbound delivery when ctx has no `sessionKey` (typical cron).
 * After a gateway restart the in-memory map is empty even though `~/.openclaw/.../friday-history/*.json` exists.
 */
export function resolveHistorySessionKeyForFridayDevice(deviceId: string): string | undefined {
  const did = deviceId.trim().toUpperCase();
  if (!did || did.toLowerCase() === "friday") return undefined;
  const fromMemory = latestHistorySessionKeyForDeviceId(did);
  if (fromMemory) return fromMemory;
  const candidates = [`agent:main:friday-${did}`, `friday-${did}`];
  for (const sk of candidates) {
    try {
      if (fs.existsSync(path.join(FRIDAY_HISTORY_DIR, `${sk}.json`))) return sk;
    } catch {
      // ignore
    }
  }
  return `agent:main:friday-${did}`;
}

const FRIDAY_CHANNEL_PLACEHOLDER = "friday";

/**
 * Resolve the real device UUID for Friday outbound (`sendText` / `sendMedia`).
 *
 * OpenClaw may pass `to: "friday"` (channel id) when the job only declares `channel: friday`
 * without a concrete peer — but SSE connections are keyed by deviceId, not `"friday"`.
 * Resolution order: explicit non-placeholder `to` → session keys on the dispatch ctx →
 * sole active SSE connection → last device that POSTed /friday/messages (offline cron delivery).
 */
export function resolveFridayDeviceIdForOutbound(
  to: string | undefined,
  rawCtx?: Record<string, unknown>,
): string {
  const trimmed = (to ?? "").trim();
  if (trimmed && trimmed.toLowerCase() !== FRIDAY_CHANNEL_PLACEHOLDER) {
    return trimmed;
  }
  const sk =
    (typeof rawCtx?.requesterSessionKey === "string" && rawCtx.requesterSessionKey.trim()) ||
    (typeof rawCtx?.sessionKey === "string" && rawCtx.sessionKey.trim()) ||
    "";
  if (sk) {
    const fromSession = resolveFridayDeviceIdForSessionKey(sk);
    if (fromSession) return fromSession;
  }
  const sole = sseEmitter.getSoleConnectedDeviceId();
  if (sole) return sole;
  if (lastRegisteredFridayDeviceId) return lastRegisteredFridayDeviceId;
  return trimmed || FRIDAY_CHANNEL_PLACEHOLDER;
}

const seenAgentEventKeys = new Set<string>();
const MAX_AGENT_EVENT_KEYS = 4000;

function stableDedupeKey(evt: {
  runId: string;
  seq?: number;
  stream: string;
  data: Record<string, unknown>;
}): string {
  if (typeof evt.seq === "number" && Number.isFinite(evt.seq)) {
    return `${evt.runId}:${evt.seq}`;
  }
  try {
    return `${evt.runId}:${evt.stream}:${JSON.stringify(evt.data)}`;
  } catch {
    return `${evt.runId}:${evt.stream}`;
  }
}

/**
 * Forward global agent stream events (thinking / assistant / …) to the Friday SSE connection.
 *
 * Used so asynchronous follow-up runs (e.g. sub-agent announce) that may not share the same
 * dispatch `replyCallbacks` bag still reach the app on the same logical run as the last POST
 * /friday/messages turn (`getLastRunIdForDevice`).
 *
 * Dedupes by `sourceRunId:seq` so the same event is not sent twice when it is both observed here
 * and via `dispatchReplyWithDispatcher` callbacks.
 */
export function forwardAgentEventToFridaySse(evt: {
  runId: string;
  seq?: number;
  stream: string;
  data: Record<string, unknown>;
  sessionKey?: string;
}): void {
  let sk = typeof evt.sessionKey === "string" ? evt.sessionKey.trim() : "";
  if (!sk) {
    const ctx = getOpenClawAgentRunContext(evt.runId);
    const fromCtx = typeof ctx?.sessionKey === "string" ? ctx.sessionKey.trim() : "";
    if (fromCtx) sk = fromCtx;
  }
  if (!sk) return;

  const deviceIdRaw = resolveFridayDeviceIdForSessionKey(sk);
  if (!deviceIdRaw) return;

  const dedupeKey = stableDedupeKey(evt);
  if (seenAgentEventKeys.has(dedupeKey)) return;
  seenAgentEventKeys.add(dedupeKey);
  if (seenAgentEventKeys.size > MAX_AGENT_EVENT_KEYS) {
    seenAgentEventKeys.clear();
  }

  const deviceId = deviceIdRaw.toUpperCase();
  const targetRunId = sseEmitter.getLastRunIdForDevice(deviceId) ?? evt.runId;
  /** After run-complete the gateway untrackRun(parent); use deviceId in payload so SSE still delivers. */
  const directToDevice = !sseEmitter.hasTrackedDevices(targetRunId);

  const d = evt.data;
  const pickText = (): string => {
    if (typeof d.text === "string") return d.text;
    if (typeof d.delta === "string") return d.delta;
    if (typeof d.content === "string") return d.content;
    return "";
  };

  const stream = evt.stream;
  if (stream === "assistant") {
    const text = pickText();
    if (!text) return;
    const phase = typeof d.phase === "string" ? d.phase : "delta";
    // Keep full `text` here: the same run may also stream via `onPartialReply`, which shares
    // `takeFinalSseDelta(runId)` state — applying delta twice would race and drop chunks.
    sseEmitter.broadcastToRun(targetRunId, {
      type: "final",
      data: {
        ...d,
        phase,
        text,
        runId: targetRunId,
        ...(directToDevice ? { deviceId } : {}),
      },
    });
    const historySk = historySessionKeyForGatewaySessionKey(sk);
    if (historySk) {
      appendLateAssistantText({ sessionKey: historySk, parentRunId: targetRunId, text });
    }
    return;
  }

  if (stream === "thinking") {
    const text = pickText();
    if (!text) return;
    const phase = typeof d.phase === "string" ? d.phase : "delta";
    sseEmitter.broadcastToRun(targetRunId, {
      type: "reasoning",
      data: {
        ...d,
        phase,
        text,
        runId: targetRunId,
        ...(directToDevice ? { deviceId } : {}),
      },
    });
    const historySk = historySessionKeyForGatewaySessionKey(sk);
    if (historySk) {
      appendLateReasoningDelta({ sessionKey: historySk, parentRunId: targetRunId, text });
    }
    return;
  }

  sseEmitter.broadcastToRun(targetRunId, {
    type: stream as "agent",
    data: { ...d, runId: targetRunId, ...(directToDevice ? { deviceId } : {}) },
  });
}
