import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginHookBeforeToolCallEvent, PluginHookAfterToolCallEvent, PluginHookToolContext } from "openclaw/plugin-sdk/plugins/types";
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
  resolveFridayDeviceIdForSessionKey,
} from "./src/friday-session.js";
import { setFridayAgentForwardRuntime } from "./src/agent-forward-runtime.js";
import { getOpenClawAgentRunContext } from "./src/agent-run-context-bridge.js";

export { fridayNextChannelPlugin } from "./src/channel.js";
export { setFridayNextRuntime } from "./src/runtime.js";

/** `api.on` returns void — register tool hooks at most once per process. */
let fridayNextToolHooksRegistered = false;
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
      : (ctx.runId ? getOpenClawAgentRunContext(ctx.runId)?.sessionKey?.trim() : undefined) ?? "";
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
  plugin: fridayNextChannelPlugin as ChannelPlugin,
  setRuntime: setFridayNextRuntime,
  registerFull: (api: OpenClawPluginApi) => {
    setFridayAgentForwardRuntime(api);
    const sameApi = lastApiRoutesRegistered?.deref() === api;
    if (!sameApi) {
      lastApiRoutesRegistered = new WeakRef(api);
      registerFridayNextHttpRoutes(api);
    } else {
      const cfg = resolveFridayNextConfig(getHostOpenClawConfigSnapshot(getFridayNextRuntime().config));
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

    if (fridayNextToolHooksRegistered) {
      return;
    }
    fridayNextToolHooksRegistered = true;

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

    api.on("before_tool_call", (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => {
      if (!shouldForwardToolEventToFriday(ctx)) return;
      const deviceId = deviceIdFromToolContext(ctx);
      const runId = ctx.runId ?? "(unknown)";

      const logLine = (detail: string) => {
        const ts = new Date().toISOString();
        console.error(
          `[Friday-HOOK] [${ts}] [TOOL_CALL] toolName=${event.toolName} runId=${runId} deviceId=${deviceId ?? "(unknown)"} detail=${detail}`,
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
    });

    api.on("after_tool_call", (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => {
      if (!shouldForwardToolEventToFriday(ctx)) return;
      const deviceId = deviceIdFromToolContext(ctx);
      const runId = ctx.runId ?? "(unknown)";

      const logLine = (detail: string) => {
        const ts = new Date().toISOString();
        console.error(
          `[Friday-HOOK] [${ts}] [TOOL_DONE] toolName=${event.toolName} runId=${runId} deviceId=${deviceId ?? "(unknown)"} detail=${detail}`,
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
    });
  },
});
