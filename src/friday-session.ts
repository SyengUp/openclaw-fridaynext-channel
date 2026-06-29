import { sseEmitter } from "./sse/emitter.js";
import { getFridayAgentForwardRuntime } from "./agent-forward-runtime.js";
import { toSessionStoreKey } from "./session/session-manager.js";
import { getOpenClawAgentRunContext } from "./agent-run-context-bridge.js";
import { observeAgentEventForActiveRuns } from "./agent/active-runs.js";
import { getRunMetadata, ingestAgentEventMetadata } from "./run-metadata.js";
import { consumeRunUsage } from "./agent/run-usage-accumulator.js";
import type { FridaySessionUsagePayload } from "./session-usage-snapshot.js";
import { readSessionUsageSnapshotFromStore } from "./session-usage-store.js";
import {
  lookupByRunId,
  lookupByChildSessionKey,
  parseAnnounceRunId,
  registerSessionKeyForRun,
  registerSpawnIntent,
  consumeSpawnIntent,
  ensureSubagentFromSpawnTool,
  registerEnded as registerSubagentEnded,
} from "./agent/subagent-registry.js";

/** Last `data.text` per run for `stream: "thinking"` — OpenClaw core may send cumulative `delta`; we rewrite true increments for the app. */
const lastThinkingTextByRun = new Map<string, string>();

function commonPrefixLength(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/** Vitest-only: clears per-run reasoning text cache used for incremental `delta` rewriting. */
export function resetThinkingStreamAccumStateForTest(): void {
  lastThinkingTextByRun.clear();
}

/**
 * Runs backed by the OpenClaw Codex app-server backend (model api `openai-chatgpt-responses`).
 * They emit their activity under a `codex_app_server.*` stream namespace and — unlike the embedded
 * runner — do NOT put reasoning text on the agent-event bus (`stream: "thinking"`); that text only
 * arrives via the dispatch `onReasoningStream` callback. Likewise exec stdout never reaches the
 * `command_output` stream. We mark a run as Codex the first time we see any `codex_app_server.*`
 * frame so the message handler / tool hooks know to synthesize the missing `thinking` /
 * `command_output` events for it (and ONLY for it — embedded runs already get both via the bus).
 */
const codexRunIds = new Set<string>();

/** True once a `codex_app_server.*` frame has been seen for this run. */
export function isCodexRun(runId: string): boolean {
  return codexRunIds.has(runId);
}

/** Vitest-only */
export function resetCodexRunTrackingForTest(): void {
  codexRunIds.clear();
}

/**
 * OpenClaw `runId` → device UUID (uppercase).
 * When `lifecycle.end` / `error` is emitted, the gateway may call `clearAgentRunContext` before this extension's
 * `onAgentEvent` runs; combined with stripped `sessionKey` for non–Control-UI-visible runs, `forwardAgentEventRaw`
 * would otherwise return early and never forward the terminal lifecycle frame.
 */
const openClawRunIdToDeviceId = new Map<string, string>();

/** Vitest-only */
export function resetOpenClawRunDeviceMappingForTest(): void {
  openClawRunIdToDeviceId.clear();
}

/** Parse deviceId from a Friday Next channel sessionKey (friday-{deviceId} or legacy agent:main:friday-*). */
export function deviceIdFromSessionKey(sessionKey: string): string | null {
  const m1 = sessionKey.match(/^friday-next-(.+)$/i);
  if (m1) return m1[1] ?? null;
  const m2 = sessionKey.match(/^agent:main:friday-next-(.+)$/i);
  return m2 ? (m2[1] ?? null) : null;
}

/**
 * When the app uses a plain `sessionKey` (e.g. `main` → `agent:main:main` in the gateway),
 * sub-agent / announce runs still emit `onAgentEvent` with that store key — not `friday-{deviceId}`.
 * Each POST /friday-next/messages registers both the raw and store keys so forwards and tool hooks resolve.
 */
const sessionKeyToDeviceId = new Map<string, string>();
/** Gateway / store session keys → app's history `sessionKey` (verbatim from POST). */
const gatewayKeyToHistorySessionKey = new Map<string, string>();
/** deviceId → latest app history sessionKey (verbatim from POST). */
const deviceIdToLatestHistorySessionKey = new Map<string, string>();
/** Last device that called POST /friday-next/messages (same gateway process). Used for cron/outbound when `to` is placeholder and the app is offline (no SSE). */
let lastRegisteredFridayDeviceId: string | undefined;

function normalizeFridaySessionKeyCase(sk: string): string {
  return /^friday-next-|^agent:main:friday-next-/i.test(sk) ||
    /^agent:main:friday-next:direct:/i.test(sk)
    ? sk.toLowerCase()
    : sk;
}

export function registerFridaySessionDeviceMapping(rawSessionKey: string, deviceId: string): void {
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

/** Tool hooks / core may pass gateway store keys; resolve app's POST sessionKey. */
export function resolveFridayHistorySessionKey(gatewaySessionKey: string): string | undefined {
  const sk = gatewaySessionKey.trim();
  if (!sk) return undefined;
  return historySessionKeyForGatewaySessionKey(sk);
}

/** Resolve latest known app sessionKey by deviceId (from last POST). */
export function latestHistorySessionKeyForDeviceId(deviceId: string): string | undefined {
  return deviceIdToLatestHistorySessionKey.get(deviceId.trim().toUpperCase());
}

/**
 * Session key hint for outbound delivery when ctx has no `sessionKey` (typical cron).
 * Uses in-process mapping only (no plugin-side history files).
 */
export function resolveHistorySessionKeyForFridayDevice(deviceId: string): string | undefined {
  const did = deviceId.trim().toUpperCase();
  if (!did || did.toLowerCase() === "friday-next") return undefined;
  const fromMemory = latestHistorySessionKeyForDeviceId(did);
  if (fromMemory) return fromMemory;
  return `agent:main:friday-next-${did}`;
}

type ForwardAgentEventArgs = {
  runId: string;
  seq?: number;
  ts?: number;
  stream: string;
  data: Record<string, unknown>;
  sessionKey?: string;
};

function mergeRunMetadataIntoLifecycleEnd(
  runId: string,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const meta = getRunMetadata(runId);
  if (!meta) return base;
  const extra: Record<string, unknown> = {};
  if (typeof meta.modelName === "string" && meta.modelName.trim()) {
    extra.modelName = meta.modelName.trim();
  }
  if (
    typeof meta.totalTokens === "number" &&
    Number.isFinite(meta.totalTokens) &&
    meta.totalTokens > 0
  ) {
    extra.totalTokens = Math.floor(meta.totalTokens);
  }
  if (
    typeof meta.contextTokensUsed === "number" &&
    Number.isFinite(meta.contextTokensUsed) &&
    meta.contextTokensUsed > 0
  ) {
    extra.contextTokensUsed = Math.floor(meta.contextTokensUsed);
  }
  if (
    typeof meta.contextWindowMax === "number" &&
    Number.isFinite(meta.contextWindowMax) &&
    meta.contextWindowMax > 0
  ) {
    extra.contextWindowMax = Math.floor(meta.contextWindowMax);
  }
  if (Object.keys(extra).length === 0) return base;
  return { ...base, ...extra };
}

function buildSessionUsageFromRunMetadata(runId: string): FridaySessionUsagePayload | undefined {
  const meta = getRunMetadata(runId);
  if (!meta) return undefined;
  const payload: FridaySessionUsagePayload = {};
  if (typeof meta.modelName === "string" && meta.modelName.trim()) {
    payload.modelId = meta.modelName.trim();
  }
  if (typeof meta.modelProvider === "string" && meta.modelProvider.trim()) {
    payload.modelProvider = meta.modelProvider.trim();
  }
  const tokens: NonNullable<typeof payload.tokens> = {};
  if (typeof meta.inputTokens === "number") tokens.input = meta.inputTokens;
  if (typeof meta.outputTokens === "number") tokens.output = meta.outputTokens;
  if (typeof meta.cacheReadTokens === "number") tokens.cacheRead = meta.cacheReadTokens;
  if (typeof meta.cacheWriteTokens === "number") tokens.cacheWrite = meta.cacheWriteTokens;
  if (typeof meta.totalTokens === "number") tokens.total = meta.totalTokens;
  if (Object.keys(tokens).length > 0) payload.tokens = tokens;
  const context: NonNullable<typeof payload.context> = {};
  if (typeof meta.contextWindowMax === "number") context.windowMax = meta.contextWindowMax;
  if (typeof meta.totalTokens === "number") context.used = meta.totalTokens;
  if (Object.keys(context).length > 0) payload.context = context;
  if (!payload.modelId && !payload.modelProvider && !payload.tokens && !payload.context) {
    return undefined;
  }
  return payload;
}

function mergeUsage(
  llmUsage: FridaySessionUsagePayload | undefined,
  memUsage: FridaySessionUsagePayload | undefined,
): FridaySessionUsagePayload | undefined {
  if (!llmUsage && !memUsage) return undefined;
  if (!llmUsage) return memUsage;
  if (!memUsage) return llmUsage;
  // llm_output tokens are authoritative (per API call, no race);
  // RunMetadata fills context window gaps.
  return {
    modelId: llmUsage.modelId ?? memUsage.modelId,
    modelProvider: llmUsage.modelProvider ?? memUsage.modelProvider,
    tokens: llmUsage.tokens,
    context: memUsage.context ?? llmUsage.context,
    estimatedCostUsd: llmUsage.estimatedCostUsd ?? memUsage.estimatedCostUsd,
  };
}

function completeAgentEventForward(params: {
  evt: ForwardAgentEventArgs;
  sk: string;
  deviceIdRaw: string;
  outgoingData: Record<string, unknown>;
  isTerminalLifecycle: boolean;
  subagentMeta?: {
    label?: string;
    parentRunId?: string;
    depth: number;
    childSessionKey?: string;
    status?: string;
  };
}): void {
  const { evt, sk, deviceIdRaw, outgoingData, isTerminalLifecycle, subagentMeta } = params;

  observeAgentEventForActiveRuns({ stream: evt.stream, runId: evt.runId, data: outgoingData });

  const deviceId = deviceIdRaw.toUpperCase();
  const targetRunId = sseEmitter.getLastRunIdForDevice(deviceId) ?? evt.runId;
  const directToDevice = !sseEmitter.hasTrackedDevices(targetRunId);

  const payload: Record<string, unknown> = {
    runId: evt.runId,
    seq: evt.seq,
    ts: evt.ts,
    stream: evt.stream,
    data: outgoingData,
    sessionKey: evt.sessionKey ?? sk,
  };
  if (directToDevice) payload.deviceId = deviceId;
  if (subagentMeta) payload.subagent = subagentMeta;

  sseEmitter.broadcastToRun(targetRunId, { type: "agent", data: payload });

  if (isTerminalLifecycle) {
    openClawRunIdToDeviceId.delete(evt.runId);
  }
}

/**
 * Resolve the real device UUID for Friday outbound (`sendText` / `sendMedia`).
 */
export function resolveFridayDeviceIdForOutbound(
  to: string | undefined,
  rawCtx?: Record<string, unknown>,
): string {
  const trimmed = (to ?? "").trim();
  if (trimmed && trimmed.toLowerCase() !== "friday-next") {
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
  return trimmed || "friday-next";
}

/**
 * Stringify a subagent error payload for the wire. `evt.data.error` comes from an
 * in-process SDK callback, so it can be a real Error, a plain object, or a value
 * that JSON.stringify would throw on (circular/BigInt) — keep this total and
 * never-throwing, since it runs on the error path that emits `subagent ended`.
 */
function stringifySubagentError(raw: unknown): string {
  if (raw == null) return "unknown";
  if (typeof raw === "string") return raw;
  if (raw instanceof Error) return raw.message || raw.name || "error";
  try {
    return JSON.stringify(raw) ?? "unknown";
  } catch {
    return "unstringifiable error";
  }
}

/**
 * Forward global OpenClaw agent events to the Friday SSE connection (transparent).
 *
 * Asynchronous follow-up runs still reach the device via `getLastRunIdForDevice` when the parent run
 * is no longer tracked.
 */
export function forwardAgentEventRaw(evt: ForwardAgentEventArgs): void {
  ingestAgentEventMetadata(evt.runId, evt.data);

  let sk = typeof evt.sessionKey === "string" ? evt.sessionKey.trim() : "";
  if (!sk) {
    const ctx = getOpenClawAgentRunContext(evt.runId);
    const fromCtx = typeof ctx?.sessionKey === "string" ? ctx.sessionKey.trim() : "";
    if (fromCtx) sk = fromCtx;
  }

  let deviceIdRaw = sk ? resolveFridayDeviceIdForSessionKey(sk) : null;
  if (!deviceIdRaw) {
    const mapped = openClawRunIdToDeviceId.get(evt.runId);
    if (mapped) deviceIdRaw = mapped;
  }
  // Subagent runs have their deviceId in the subagent registry
  if (!deviceIdRaw) {
    const sub = lookupByRunId(evt.runId);
    if (sub) deviceIdRaw = sub.deviceId;
  }
  if (!deviceIdRaw) return;

  if (!sk) {
    sk = latestHistorySessionKeyForDeviceId(deviceIdRaw) ?? `friday-next-${deviceIdRaw}`;
  }

  openClawRunIdToDeviceId.set(evt.runId, deviceIdRaw.toUpperCase());

  // Flag Codex app-server runs so the message handler / tool hooks synthesize the `thinking` /
  // `command_output` events that this backend never emits on the bus (see `isCodexRun`).
  if (typeof evt.stream === "string" && evt.stream.startsWith("codex_app_server")) {
    codexRunIds.add(evt.runId);
  }

  // Codex app-server reasoning: newer OpenClaw cores stopped invoking the dispatch
  // `onReasoningStream` callback (the A2 path in messages.ts) and instead stream the
  // reasoning summary on the agent-event bus as `stream:"item" kind:"preamble"` with a
  // cumulative `progressText` (source "codex-app-server"). The Friday app only renders
  // `stream:"thinking"`, so translate it here — synthesize a thinking event reusing the
  // cumulative→delta rewrite below. The raw preamble item is still forwarded but the app
  // ignores unknown item kinds. (The onReasoningStream callback stays as a harmless
  // fallback for cores that still fire it.)
  if (
    evt.stream === "item" &&
    evt.data.kind === "preamble" &&
    evt.data.source === "codex-app-server"
  ) {
    codexRunIds.add(evt.runId);
    const reasoningText = typeof evt.data.progressText === "string" ? evt.data.progressText : "";
    if (reasoningText) {
      forwardAgentEventRaw({
        runId: evt.runId,
        stream: "thinking",
        data: { text: reasoningText },
        sessionKey: evt.sessionKey ?? sk,
      });
    }
  }

  // Codex app-server projects every tool/command call onto BOTH the standard `tool` stream
  // (carrying args + the real result) AND a redundant `item` event (kind:"tool"/"command"),
  // and core flags that item `suppressChannelProgress: true` ("do not surface in channel
  // progress"). Forwarding the suppressed *tool* item double-renders every non-exec tool in the
  // app — the `tool`-stream row plus a second `item kind:tool` row, with the result landing only
  // on the first. So drop ONLY suppressed `kind:"tool"` items.
  //
  // BUT keep suppressed `kind:"command"`/`"process"` items: the `tool` stream's exec result is
  // just {exitCode,duration} (no stdout), and the app bootstraps its command-terminal row from
  // the `item kind:command` event — that row is what the synthesized `command_output` end event
  // then attaches the real stdout to. Dropping it left exec tools with a command line and no
  // output in the trace. (Reasoning items preamble/analysis are never suppressed.)
  if (
    evt.stream === "item" &&
    evt.data.suppressChannelProgress === true &&
    evt.data.kind === "tool"
  ) {
    return;
  }

  // Register sessionKey → runId so we can resolve parentRunId
  if (sk && evt.stream === "lifecycle" && evt.data.phase === "start") {
    registerSessionKeyForRun(sk, evt.runId);
  }

  // ── sessions_spawn tool → subagent lifecycle (replaces hooks) ──
  const isSpawnTool =
    evt.stream === "tool" && (evt.data.name === "sessions_spawn" || evt.data.name === "task");

  // Phase 1: spawning — tool.start with taskName in args
  if (isSpawnTool && evt.data.phase === "start") {
    const toolCallId = typeof evt.data.toolCallId === "string" ? evt.data.toolCallId : "";
    const args = evt.data.args as Record<string, unknown> | undefined;
    const label = typeof args?.taskName === "string" ? args.taskName : undefined;
    if (toolCallId) {
      const intent = registerSpawnIntent({
        toolCallId,
        label,
        deviceId: deviceIdRaw,
        parentRunId: evt.runId,
        requesterSessionKey: sk || undefined,
      });
      sseEmitter.broadcast(
        {
          type: "subagent",
          data: {
            phase: "spawning",
            childSessionKey: null,
            runId: null,
            // A2: the spawn tool-call id is the only stable correlation key before the
            // gateway assigns childSessionKey/runId — the app mints the placeholder window
            // under it, then rekeys to childSessionKey on spawned.
            toolCallId,
            label: intent.label ?? null,
            parentRunId: intent.parentRunId,
            depth: intent.depth,
            deviceId: intent.deviceId,
          },
        },
        intent.deviceId,
      );
    }
  }

  // Phase 2: spawned — tool.result with childSessionKey + runId
  if (isSpawnTool && evt.data.phase === "result") {
    const details = (evt.data.result as Record<string, unknown> | undefined)?.details as
      | { childSessionKey?: string; runId?: string; taskName?: string }
      | undefined;
    if (details?.childSessionKey) {
      const toolCallId = typeof evt.data.toolCallId === "string" ? evt.data.toolCallId : "";
      const intent = toolCallId ? consumeSpawnIntent(toolCallId) : undefined;
      const label =
        details.taskName ||
        intent?.label ||
        (typeof evt.data.meta === "string" ? evt.data.meta : undefined);
      const entry = ensureSubagentFromSpawnTool({
        childSessionKey: details.childSessionKey,
        bareRunId: details.runId,
        label,
        deviceId: deviceIdRaw,
        parentRunId: intent?.parentRunId ?? evt.runId,
        requesterSessionKey: sk,
        depth: intent?.depth,
      });
      const compoundRunId = entry.runId ?? evt.runId;
      sseEmitter.trackDeviceForRun(entry.deviceId, compoundRunId);
      sseEmitter.broadcast(
        {
          type: "subagent",
          data: {
            phase: "spawned",
            runId: compoundRunId,
            childSessionKey: entry.childSessionKey,
            // A2: echo the spawn toolCallId so the app deterministically links this
            // spawned event to the placeholder window it minted at spawning time.
            toolCallId: toolCallId || null,
            label: entry.label ?? null,
            parentRunId: entry.parentRunId ?? null,
            depth: entry.depth,
            deviceId: entry.deviceId,
          },
        },
        entry.deviceId,
      );
    }
  }

  // Phase 3 (A3): announce-summary delivery to the parent. OpenClaw emits the parent's
  // `lifecycle.start` under the announce compound runId once a subagent's result is being
  // folded back in. We parse the authoritative childSessionKey here (the registry already
  // knows how) and broadcast an explicit `dismissed` subagent event, so the app removes the
  // settled window by childSessionKey instead of re-parsing the announce runId itself.
  if (evt.stream === "lifecycle" && evt.data.phase === "start") {
    const announced = parseAnnounceRunId(evt.runId);
    if (announced) {
      const entry = lookupByChildSessionKey(announced.childSessionKey) ?? lookupByRunId(evt.runId);
      sseEmitter.broadcast(
        {
          type: "subagent",
          data: {
            phase: "dismissed",
            childSessionKey: entry?.childSessionKey ?? announced.childSessionKey,
            runId: entry?.runId ?? announced.bareRunId ?? null,
            parentRunId: entry?.parentRunId ?? null,
            depth: entry?.depth ?? 1,
            deviceId: deviceIdRaw,
          },
        },
        deviceIdRaw,
      );
    }
  }

  const subagentEntry = lookupByRunId(evt.runId);
  // Only annotate events that originate from the subagent itself
  // (sessionKey matches childSessionKey). Main-agent delivery events
  // share the announce runId but have a different sessionKey.
  const isSubagentOwnEvent = subagentEntry && sk && subagentEntry.childSessionKey === sk;
  const subagentMeta = isSubagentOwnEvent
    ? {
        label: subagentEntry.label,
        parentRunId: subagentEntry.parentRunId,
        depth: subagentEntry.depth,
        // A1: ship the authoritative childSessionKey + lifecycle status on every
        // subagent agent-delta so the app routes/identifies by stable keys instead of
        // guessing from runId.
        childSessionKey: subagentEntry.childSessionKey,
        status: subagentEntry.status,
      }
    : undefined;

  let outgoingData: Record<string, unknown> = { ...evt.data };

  if (evt.stream === "thinking") {
    const currentText = typeof evt.data.text === "string" ? evt.data.text : "";
    const prior = lastThinkingTextByRun.get(evt.runId) ?? "";
    const prefixLen = commonPrefixLength(prior, currentText);
    const delta = currentText.slice(prefixLen);
    lastThinkingTextByRun.set(evt.runId, currentText);
    outgoingData = {
      ...evt.data,
      text: currentText,
      delta,
      reasoningPrefixChars: prefixLen,
    };
  } else if (evt.stream === "lifecycle") {
    const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
    if (phase === "end") {
      outgoingData = mergeRunMetadataIntoLifecycleEnd(evt.runId, outgoingData);
    }
    if (phase === "end" || phase === "error") {
      lastThinkingTextByRun.delete(evt.runId);
      codexRunIds.delete(evt.runId);
    }
  }

  const lifecyclePhase =
    evt.stream === "lifecycle" && typeof evt.data.phase === "string" ? evt.data.phase : "";
  const isTerminalLifecycle =
    evt.stream === "lifecycle" && (lifecyclePhase === "end" || lifecyclePhase === "error");

  // Emit subagent ended SSE when a subagent run terminates
  if (isTerminalLifecycle && isSubagentOwnEvent && subagentEntry.status !== "ended") {
    const outcome = lifecyclePhase === "error" ? "error" : "ok";
    const errorStr =
      lifecyclePhase === "error" ? stringifySubagentError(evt.data.error) : undefined;
    const ended = registerSubagentEnded({ runId: evt.runId, outcome, error: errorStr });
    if (ended) {
      sseEmitter.broadcast(
        {
          type: "subagent",
          data: {
            phase: "ended",
            runId: ended.runId ?? evt.runId ?? null,
            childSessionKey: ended.childSessionKey,
            label: ended.label ?? null,
            parentRunId: ended.parentRunId ?? null,
            depth: ended.depth,
            deviceId: ended.deviceId,
            outcome: ended.outcome ?? null,
            error: ended.error ?? null,
          },
        },
        ended.deviceId,
      );
    }
  }

  // Build sessionUsage: store (cumulative session totals) → llm_output (per-run fallback).
  if (isTerminalLifecycle && getFridayAgentForwardRuntime()) {
    // Defer to let store write complete, then read cumulative totals.
    // llm_output data is per-run; store is cumulative across rounds.
    setTimeout(() => {
      let data = outgoingData;
      const storeUsage = readSessionUsageSnapshotFromStore(sk);
      const llmUsage = consumeRunUsage(evt.runId);
      const memUsage = buildSessionUsageFromRunMetadata(evt.runId);
      let usage: FridaySessionUsagePayload | undefined;
      if (storeUsage) {
        // Store provides cumulative session totals. Supplement with
        // fresher model/provider from llm_output when available.
        usage = storeUsage;
        if (llmUsage?.modelId) usage.modelId = llmUsage.modelId;
        if (llmUsage?.modelProvider) usage.modelProvider = llmUsage.modelProvider;
      } else {
        // First message in session — store not yet written, fall back
        // to per-run llm_output + RunMetadata.
        usage = mergeUsage(llmUsage, memUsage);
      }
      if (usage) {
        data = { ...outgoingData, sessionUsage: usage };
      }
      completeAgentEventForward({
        evt,
        sk,
        deviceIdRaw,
        outgoingData: data,
        isTerminalLifecycle: true,
        subagentMeta,
      });
    }, 100);
    return;
  }

  completeAgentEventForward({
    evt,
    sk,
    deviceIdRaw,
    outgoingData,
    isTerminalLifecycle,
    subagentMeta,
  });
}
