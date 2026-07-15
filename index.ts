import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookAfterToolCallEvent,
  PluginHookToolContext,
} from "openclaw/plugin-sdk/plugins/types";
import { fridayNextChannelPlugin } from "./src/channel.js";
import { setFridayNextRuntime } from "./src/runtime.js";
import { resolveFridayNextConfig } from "./src/config.js";
import { getHostOpenClawConfigSnapshot } from "./src/host-config.js";
import { registerFridayNextHttpRoutes } from "./src/http/server.js";
import { getFridayNextRuntime } from "./src/runtime.js";
import { sseEmitter } from "./src/sse/emitter.js";
import {
  forwardAgentEventRaw,
  getLastRegisteredFridayDeviceId,
  isCodexRun,
  resolveFridayDeviceIdForSessionKey,
} from "./src/friday-session.js";
import { setFridayAgentForwardRuntime } from "./src/agent-forward-runtime.js";
import { setUpgradeRuntime } from "./src/upgrade-runtime.js";
import { noteCronActivity } from "./src/notifications/cron-notification-tracker.js";
import { noteHeartbeatActivity } from "./src/notifications/heartbeat-notification-tracker.js";
import { getOpenClawAgentRunContext } from "./src/agent-run-context-bridge.js";
import { accumulateRunUsage } from "./src/agent/run-usage-accumulator.js";
import { createFridayNextLogger } from "./src/logging.js";
import { ensureCodexReasoningSummary } from "./src/codex-reasoning-config.js";
import { startPublicAccess } from "./src/public-access/frpc-manager.js";

const hookLogger = createFridayNextLogger("hook");

export { fridayNextChannelPlugin } from "./src/channel.js";
export { setFridayNextRuntime } from "./src/runtime.js";

let disposeAgentEventListener: (() => void) | null = null;
/**
 * Track the last `api` instance on which HTTP routes were registered.
 * When the health-monitor restarts the plugin, `registerFull` receives a fresh `api` whose
 * old routes are gone — we must re-register.  A WeakRef lets us distinguish "same api,
 * re-entered" (skip) from "new api after restart" (re-register).
 */
let lastApiRoutesRegistered: WeakRef<OpenClawPluginApi> | null = null;

function deviceIdFromToolContext(ctx: PluginHookToolContext): string | null {
  if (ctx.runId) {
    const d = sseEmitter.getDeviceIdByRunId(ctx.runId);
    if (d) return d;
  }
  const sk =
    typeof ctx.sessionKey === "string" && ctx.sessionKey.trim()
      ? ctx.sessionKey.trim()
      : ((ctx.runId ? getOpenClawAgentRunContext(ctx.runId)?.sessionKey?.trim() : undefined) ?? "");
  if (sk) {
    const d = resolveFridayDeviceIdForSessionKey(sk);
    if (d) return d;
  }
  const sole = sseEmitter.getSoleConnectedDeviceId();
  if (sole) return sole;
  const last = getLastRegisteredFridayDeviceId();
  if (last) return last;
  return null;
}

function isFridaySessionKey(sk: string): boolean {
  return /^friday-next-/i.test(sk) || /^agent:main:friday-next-/i.test(sk);
}

/** Shell/exec-style tools whose stdout the app renders as a `command_output` row (A3). */
const COMMAND_TOOL_NAMES = new Set([
  "exec",
  "bash",
  "shell",
  "local_shell",
  "command",
  "process",
  "run_terminal_cmd",
]);

function isCommandTool(toolName: unknown): boolean {
  return typeof toolName === "string" && COMMAND_TOOL_NAMES.has(toolName.trim().toLowerCase());
}

/** Best-effort flatten of an after-hook tool result into the stdout string the app expects. */
function coerceCommandOutput(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    for (const key of ["output", "stdout", "text"]) {
      if (typeof r[key] === "string") return r[key] as string;
    }
    try {
      return JSON.stringify(result);
    } catch {
      return "";
    }
  }
  return result == null ? "" : String(result);
}

function shouldForwardToolEventToFriday(ctx: PluginHookToolContext): boolean {
  if (ctx.runId) {
    if (sseEmitter.getDeviceIdByRunId(ctx.runId)) return true;
    const runSk = getOpenClawAgentRunContext(ctx.runId)?.sessionKey?.trim() ?? "";
    if (runSk) {
      if (resolveFridayDeviceIdForSessionKey(runSk)) return true;
      if (isFridaySessionKey(runSk)) return true;
    }
  }

  const sk = typeof ctx.sessionKey === "string" ? ctx.sessionKey.trim() : "";
  if (sk) {
    if (resolveFridayDeviceIdForSessionKey(sk)) return true;
    if (isFridaySessionKey(sk)) return true;
  }

  return false;
}

export default defineChannelPluginEntry({
  id: "friday-next",
  name: "Friday Next",
  description: "Friday Next Apple 应用通道",
  plugin: fridayNextChannelPlugin,
  setRuntime: setFridayNextRuntime,
  registerFull: (api: OpenClawPluginApi) => {
    setFridayAgentForwardRuntime(api);
    setUpgradeRuntime(api);
    const sameApi = lastApiRoutesRegistered?.deref() === api;
    if (!sameApi) {
      lastApiRoutesRegistered = new WeakRef(api);
      registerFridayNextHttpRoutes(api);

      // Public access (FridayNext 云): bring up the frpc tunnel if enabled. Idempotent — a stale
      // frpc from a prior plugin reload is killed before respawn. Inert when disabled.
      try {
        const paCfg = resolveFridayNextConfig(
          getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
        );
        const paLog = createFridayNextLogger("public-access");
        void startPublicAccess(
          {
            enabled: paCfg.publicAccess.enabled,
            relayAddr: paCfg.publicAccess.relayAddr,
            relayToken: paCfg.publicAccess.relayToken,
            subDomainHost: paCfg.publicAccess.subDomainHost,
            subdomain: paCfg.publicAccess.subdomain || undefined,
            allocatorUrl: paCfg.publicAccess.allocatorUrl,
            certSignUrl: paCfg.publicAccess.certSignUrl,
            corePort: paCfg.publicAccess.corePort,
            authToken: paCfg.authToken,
          },
          (m) => paLog.info(m),
        ).catch((e: unknown) =>
          paLog.warn(`startPublicAccess failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      } catch (e) {
        createFridayNextLogger("public-access").warn(
          `startPublicAccess failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } else {
      const cfg = resolveFridayNextConfig(
        getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
      );
      sseEmitter.setBacklogLimit(cfg.sseBacklogPerDevice);
    }

    disposeAgentEventListener?.();
    disposeAgentEventListener = api.runtime.events.onAgentEvent((evt: any) => {
      forwardAgentEventRaw({
        runId: evt.runId,
        seq: evt.seq,
        ts: evt.ts,
        stream: evt.stream as string,
        data: evt.data as Record<string, unknown>,
        sessionKey: evt.sessionKey,
      });
    });

    api.on("llm_output", (event: any) => {
      accumulateRunUsage(
        event.runId,
        {
          input: event.usage?.input,
          output: event.usage?.output,
          cacheRead: event.usage?.cacheRead,
          cacheWrite: event.usage?.cacheWrite,
          total: event.usage?.total,
        },
        event.model,
        event.provider,
      );
    });

    // Tool hooks (subagent_delivery_target / before_tool_call / after_tool_call) must follow the
    // SAME re-registration discipline as the HTTP routes and onAgentEvent listener above. When the
    // health-monitor restarts the plugin, `registerFull` receives a fresh `api` and the host
    // dispatches hooks on THAT api; hooks left bound to the first api go silent for the rest of the
    // process. The old one-time boolean guard bound them to whichever api arrived first — which is
    // exactly why Codex `command_output` (the A3 after_tool_call stdout synthesis) fired on some
    // gateway processes and not others. Re-register on every genuinely-new api; skip only a repeat
    // call with the same api (matching the `!sameApi` gate the routes use).
    if (sameApi) {
      return;
    }

    // Make Codex (ChatGPT/OAuth) models emit reasoning summary text so the app can stream
    // "thinking". OpenClaw never sets this; we assert it on the plugin side. Best-effort.
    ensureCodexReasoningSummary((msg) => hookLogger.info(msg));

    // Track scheduled-task (cron) activity so the notifications inbox can subtitle an
    // offline background push with its originating cron job's NAME. A real `announce`
    // cron delivery reaches the channel outbound with no cron origin (see channel.ts
    // sendText), so we anchor on this first-party lifecycle hook instead.
    api.on("cron_changed", (event: any) => {
      if (event?.action !== "started" && event?.action !== "finished") return;
      // Best-effort origin agent so the notifications inbox attributes the push to the job's
      // owning agent, not the delivery session's (usually the app's current `main`). Falls back
      // to the session-key derivation when the event doesn't carry it — no regression.
      const cronAgentId = event.job?.agentId ?? event.agentId ?? undefined;
      noteCronActivity(event.jobId, event.job?.name, cronAgentId);
      hookLogger.info(
        `[CRON_CHANGED] action=${event.action} jobId=${event.jobId ?? "(none)"} name=${event.job?.name ?? "(none)"} agent=${cronAgentId ?? "(none)"}`,
      );
    });

    // Track heartbeat-run starts so the notifications inbox can label an offline background
    // push as a "heartbeat" (not a generic "push"). Like cron, a real heartbeat `announce`
    // delivery reaches the channel outbound with no origin marker; unlike cron, the only
    // ordering-safe first-party signal is this run-start gate (the `onHeartbeatEvent` runtime
    // event carries terminal statuses emitted after delivery). Conversation hook — fires
    // because friday-next has `hooks.allowConversationAccess` enabled.
    api.on("before_agent_run", (_event: any, ctx: any) => {
      if (ctx?.trigger !== "heartbeat") return;
      // The heartbeat run's `agent:<id>:…:heartbeat` origin key is the ONLY reliable carrier of the
      // agent that ran it — the later outbound delivery resolves to the app's current session agent
      // (usually `main`). Extract it here so the inbox subtitle reads the true origin. undefined on
      // no-match → the store falls back to the delivery-key derivation (no regression).
      const originAgentId = String(ctx?.sessionKey ?? "")
        .match(/^agent:([^:]+):/i)?.[1]
        ?.toLowerCase();
      noteHeartbeatActivity(Date.now(), originAgentId);
      hookLogger.info(
        `[HEARTBEAT_RUN] runId=${ctx?.runId ?? "(none)"} sessionKey=${ctx?.sessionKey ?? "(none)"} agent=${originAgentId ?? "(none)"}`,
      );
    });

    api.on("subagent_delivery_target", (event: any) => {
      if (!event.expectsCompletionMessage) return;
      const ch = event.requesterOrigin?.channel?.trim().toLowerCase();
      if (ch !== "friday-next") return;
      const sk = event.requesterSessionKey?.trim();
      if (!sk) return;
      const raw = resolveFridayDeviceIdForSessionKey(sk);
      if (!raw) return;
      const to = raw.toUpperCase();
      return {
        origin: {
          channel: "friday-next",
          accountId: event.requesterOrigin?.accountId?.trim() || "default",
          to,
        },
      };
    });

    api.on(
      "before_tool_call",
      (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => {
        if (!shouldForwardToolEventToFriday(ctx)) return;
        const deviceId = deviceIdFromToolContext(ctx);
        const runId = ctx.runId ?? "(unknown)";

        const logLine = (detail: string) => {
          hookLogger.debug(
            `[TOOL_CALL] toolName=${event.toolName} runId=${runId} deviceId=${deviceId ?? "(unknown)"} detail=${detail}`,
          );
        };

        if (!deviceId) {
          logLine("SKIP_no_deviceId");
          return;
        }

        logLine("START");
        sseEmitter.broadcastToolEvent(deviceId.toUpperCase(), runId, {
          type: "tool-hook",
          data: {
            when: "before",
            runId,
            deviceId: deviceId.toUpperCase(),
            sessionKey: ctx.sessionKey,
            toolName: event.toolName,
            params: event.params,
            ts: Date.now(),
          },
        });
      },
    );

    api.on("after_tool_call", (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => {
      if (!shouldForwardToolEventToFriday(ctx)) return;
      const deviceId = deviceIdFromToolContext(ctx);
      const runId = ctx.runId ?? "(unknown)";

      const logLine = (detail: string) => {
        hookLogger.debug(
          `[TOOL_DONE] toolName=${event.toolName} runId=${runId} deviceId=${deviceId ?? "(unknown)"} detail=${detail}`,
        );
      };

      if (!deviceId) {
        logLine("SKIP_no_deviceId");
        return;
      }

      logLine("END");
      const normalizedDeviceId = deviceId.toUpperCase();
      sseEmitter.broadcastToolEvent(normalizedDeviceId, runId, {
        type: "tool-hook",
        data: {
          when: "after",
          runId,
          deviceId: normalizedDeviceId,
          sessionKey: ctx.sessionKey,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          error: event.error ?? null,
          result: event.result,
          durationMs: event.durationMs ?? null,
          ts: Date.now(),
        },
      });

      // A3: the Codex app-server backend never puts exec stdout on the `command_output` stream
      // (its tool result carries only exitCode/duration), so the app shows the command row with no
      // output. The after-hook DOES carry the full stdout — synthesize a `command_output` end event
      // keyed by toolCallId (== the forwarded `item kind:command` itemId) so the app attaches it.
      // Codex-only: embedded runs already stream `command_output` on the bus.
      if (isCodexRun(runId) && event.toolCallId && isCommandTool(event.toolName)) {
        const output = coerceCommandOutput(event.result);
        if (output) {
          forwardAgentEventRaw({
            runId,
            stream: "command_output",
            data: {
              itemId: event.toolCallId,
              phase: "end",
              output,
              status: event.error ? "failed" : "completed",
              durationMs: event.durationMs ?? null,
            },
            sessionKey: ctx.sessionKey,
          });
        }
      }
    });
  },
});
