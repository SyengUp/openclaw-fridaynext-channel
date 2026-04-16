import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginHookBeforeToolCallEvent, PluginHookAfterToolCallEvent, PluginHookToolContext } from "openclaw/plugin-sdk/plugins/types";
import { fridayChannelPlugin } from "./src/channel.js";
import { setFridayRuntime } from "./src/runtime.js";
import { registerFridayHttpRoutes } from "./src/http/server.js";
import { sseEmitter } from "./src/sse/emitter.js";
import { appendToolEvent } from "./src/conversation-history.js";
import {
  captureMessageToolCandidatePaths,
  flushMessageToolAttachments,
} from "./src/attachments/message-tool-attachments.js";
import { flushTtsToolAttachments } from "./src/attachments/tts-tool-attachments.js";
import {
  forwardAgentEventToFridaySse,
  getLastRegisteredFridayDeviceId,
  latestHistorySessionKeyForDeviceId,
  resolveFridayDeviceIdForSessionKey,
  resolveFridayHistorySessionKey,
} from "./src/friday-session.js";
import { getOpenClawAgentRunContext } from "./src/agent-run-context-bridge.js";
import path from "node:path";

export { fridayChannelPlugin } from "./src/channel.js";
export { setFridayRuntime } from "./src/runtime.js";

/** Map gateway `sessionKey` → history file key (same as POST /friday/messages). */
function historySessionKeyForToolHook(
  sessionKey: string | undefined,
  deviceId: string,
): string | undefined {
  const sk = sessionKey?.trim();
  if (sk) return resolveFridayHistorySessionKey(sk) ?? sk;
  return latestHistorySessionKeyForDeviceId(deviceId);
}

function deviceIdFromToolContext(ctx: PluginHookToolContext): string | null {
  // Priority 1: runId → device (active runEmitter entry, or lastRunIdByDevice after untrackRun)
  if (ctx.runId) {
    const d = sseEmitter.getDeviceIdByRunId(ctx.runId);
    if (d) return d;
  }
  // Priority 2: sessionKey → device (friday-* pattern or POST /messages mapping for main / custom keys)
  const sk =
    typeof ctx.sessionKey === "string" && ctx.sessionKey.trim()
      ? ctx.sessionKey.trim()
      : (ctx.runId ? getOpenClawAgentRunContext(ctx.runId)?.sessionKey?.trim() : undefined) ?? "";
  if (sk) {
    const d = resolveFridayDeviceIdForSessionKey(sk);
    if (d) return d;
  }
  // Priority 3: single SSE client (typical single-phone setup)
  const sole = sseEmitter.getSoleConnectedDeviceId();
  if (sole) return sole;
  // Priority 4: last device that POSTed /friday/messages this process lifetime
  const last = getLastRegisteredFridayDeviceId();
  if (last) return last;
  return null;
}

function isFridaySessionKey(sk: string): boolean {
  return /^friday-/i.test(sk) || /^agent:main:friday-/i.test(sk);
}

/** Only forward tool events when the run/session clearly belongs to Friday. */
function shouldForwardToolEventToFriday(ctx: PluginHookToolContext): boolean {
  if (ctx.runId) {
    // Active or recently untracked Friday run already bound to a device.
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


function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** `dirname` segment + `/` + basename, e.g. `/tmp/test.txt` → `tmp/test.txt`. */
function compactPathForToolDisplay(fullPath: string): string {
  const fp = fullPath.trim();
  if (!fp) return "";
  const parent = path.basename(path.dirname(fp));
  const file = path.basename(fp);
  return parent && file ? `${parent}/${file}` : file || fp;
}

function stringifyToolStartParams(toolName: string, params: unknown): unknown {
  const p = asObject(params);
  if (!p) return params ?? {};

  if (toolName === "browser") {
    const action = typeof p.action === "string" ? p.action.trim() : "";
    const url = typeof p.url === "string" ? p.url.trim() : "";
    const text = [action, url].filter(Boolean).join(" ");
    return text || params;
  }

  if (toolName === "image_generate") {
    const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
    return prompt || params;
  }

  if (toolName === "message") {
    const action = typeof p.action === "string" ? p.action.trim() : "";
    const channel = typeof p.channel === "string" ? p.channel.trim() : "";
    const mediaPath =
      typeof p.media === "string" ? p.media :
      (typeof p.mediaUrl === "string" ? p.mediaUrl :
      (typeof p.filePath === "string" ? p.filePath : ""));
    const filename = mediaPath ? path.basename(mediaPath) : "";
    const text = `${action}${filename ? ` ${filename}` : ""}${channel ? ` to ${channel}` : ""}`.trim();
    return text || params;
  }

  if (toolName === "read") {
    const fullPath = typeof p.path === "string" ? p.path.trim() : "";
    if (!fullPath) return params;
    const compact = compactPathForToolDisplay(fullPath);
    return compact || params;
  }

  if (toolName === "canvas") {
    const action = typeof p.action === "string" ? p.action.trim() : "";
    const url = typeof p.url === "string" ? p.url.trim() : "";
    const text = [action, url].filter(Boolean).join(" ");
    return text || params;
  }

  if (toolName === "edit" || toolName === "write") {
    const fullPath = typeof p.path === "string" ? p.path.trim() : "";
    if (!fullPath) return params;
    const compact = compactPathForToolDisplay(fullPath);
    return compact || params;
  }

  if (toolName === "image") {
    const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
    return prompt || params;
  }

  if (toolName === "exec") {
    const command = typeof p.command === "string" ? p.command.trim() : "";
    return command || params;
  }

  if (toolName === "sessions_spawn") {
    const task = typeof p.task === "string" ? p.task.trim() :
      (typeof p.Task === "string" ? p.Task.trim() : "");
    return task || params;
  }

  if (toolName === "web_search") {
    const query = typeof p.query === "string" ? p.query.trim() : "";
    return query || params;
  }

  if (toolName === "process") {
    const action = typeof p.action === "string" ? p.action.trim() : "";
    return action || params;
  }

  return params;
}

export default defineChannelPluginEntry({
  id: "friday",
  name: "Friday",
  description: "Friday iOS 应用通道",
  plugin: fridayChannelPlugin as ChannelPlugin,
  setRuntime: setFridayRuntime,
  registerFull: (api: OpenClawPluginApi) => {
    registerFridayHttpRoutes(api);

    // Same idea as Feishu/Telegram `subagent_delivery_target`: announce completion must use a real
    // deliverable `to` (deviceId). Falls back when requesterOrigin still has a stale To.
    api.on("subagent_delivery_target", (event) => {
      if (!event.expectsCompletionMessage) return;
      const ch = event.requesterOrigin?.channel?.trim().toLowerCase();
      if (ch !== "friday") return;
      const sk = event.requesterSessionKey?.trim();
      if (!sk) return;
      const raw = resolveFridayDeviceIdForSessionKey(sk);
      if (!raw) return;
      const to = raw.toUpperCase();
      return {
        origin: {
          channel: "friday",
          accountId: event.requesterOrigin?.accountId?.trim() || "default",
          to,
        },
      };
    });

    // Sub-agent announce and other async follow-up runs may not reuse POST /messages
    // replyCallbacks; still emit the same agent streams (thinking → reasoning, assistant → text)
    // to the device's last tracked run.
    api.runtime.events.onAgentEvent((evt) => {
      forwardAgentEventToFridaySse({
        runId: evt.runId,
        seq: evt.seq,
        stream: evt.stream,
        data: evt.data,
        sessionKey: evt.sessionKey,
      });
    });

    // ── Tool lifecycle hooks ────────────────────────────────────────────────

    api.on("before_tool_call", (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => {
      if (!shouldForwardToolEventToFriday(ctx)) return;
      const deviceId = deviceIdFromToolContext(ctx);
      const runId = ctx.runId ?? "(unknown)";

      const logLine = (detail: string) => {
        const ts = new Date().toISOString();
        console.error(`[Friday-HOOK] [${ts}] [TOOL_CALL] toolName=${event.toolName} runId=${runId} deviceId=${deviceId ?? "(unknown)"} detail=${detail}`);
      };

      if (!deviceId) {
        logLine("SKIP_no_deviceId");
        return;
      }

      logLine("START params=" + JSON.stringify(event.params ?? {}));
      if (event.toolName === "message") {
        captureMessageToolCandidatePaths(ctx.runId, event.params);
      }
      // Normalize deviceId to uppercase to match SSE connection registry
      sseEmitter.broadcastToolEvent(deviceId!.toUpperCase(), runId, {
        type: "tool",
        data: {
          phase: "start",
          toolName: event.toolName,
          params: stringifyToolStartParams(event.toolName, event.params),
          runId,
          deviceId,
          timestamp: Date.now(),
        },
      });
      const historySk = historySessionKeyForToolHook(ctx.sessionKey, deviceId);
      if (historySk && runId !== "(unknown)") {
        appendToolEvent({
          sessionKey: historySk,
          runId,
          phase: "start",
          toolName: event.toolName,
          params: stringifyToolStartParams(event.toolName, event.params),
          deviceId: deviceId.toUpperCase(),
        });
      }
    });

    api.on("after_tool_call", (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => {
      if (!shouldForwardToolEventToFriday(ctx)) return;
      const deviceId = deviceIdFromToolContext(ctx);
      const runId = ctx.runId ?? "(unknown)";

      const logLine = (detail: string) => {
        const ts = new Date().toISOString();
        console.error(`[Friday-HOOK] [${ts}] [TOOL_DONE] toolName=${event.toolName} runId=${runId} deviceId=${deviceId ?? "(unknown)"} detail=${detail}`);
      };

      if (!deviceId) {
        logLine("SKIP_no_deviceId");
        return;
      }

      const phase = event.error ? "error" : "end";
      const text = event.result
        ? (typeof event.result === "string" ? event.result : JSON.stringify(event.result))
        : event.error ?? "";

      logLine(`phase=${phase} textLen=${text.length}` + (event.error ? ` errorText=${event.error}` : ""));

      const normalizedDeviceId = deviceId!.toUpperCase();
      sseEmitter.broadcastToolEvent(normalizedDeviceId, runId, {
        type: "tool",
        data: {
          phase,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          error: event.error ?? null,
          text,
          durationMs: event.durationMs ?? null,
          runId,
          deviceId: normalizedDeviceId,
          timestamp: Date.now(),
        },
      });
      const historySkAfter = historySessionKeyForToolHook(ctx.sessionKey, normalizedDeviceId);
      if (historySkAfter && runId !== "(unknown)") {
        appendToolEvent({
          sessionKey: historySkAfter,
          runId,
          phase: phase as "end" | "error",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text,
          error: event.error ?? null,
          durationMs: event.durationMs ?? null,
          deviceId: normalizedDeviceId,
        });
      }

      if (event.toolName === "message" && phase === "end") {
        const eventParams = (event as PluginHookAfterToolCallEvent & { params?: unknown }).params;
        flushMessageToolAttachments({
          runId: ctx.runId,
          sessionKey: ctx.sessionKey,
          deviceId: normalizedDeviceId,
          text,
          result: event.result,
          eventParams,
          logLine,
        });
      }

      if (event.toolName === "tts" && phase === "end" && !event.error) {
        flushTtsToolAttachments({
          runId: ctx.runId,
          sessionKey: ctx.sessionKey,
          deviceId: normalizedDeviceId,
          text,
          result: event.result,
          logLine,
        });
      }

    });
  },
});
