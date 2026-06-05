/**
 * Friday Next Channel Plugin Definition.
 *
 * HTTP/SSE bridge for the Friday app; outbound sendText/sendMedia are forwarded as `outbound` SSE events.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import { createFridayNextLogger } from "./logging.js";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { sseEmitter } from "./sse/emitter.js";
import { describeMessageActions, handleMessageAction } from "./channel-actions.js";
import { guessMimeType, resolveMediaAttachment } from "./http/handlers/files.js";
import {
  resolveFridayDeviceIdForOutbound,
  resolveHistorySessionKeyForFridayDevice,
} from "./friday-session.js";
import { getRunRoute } from "./run-metadata.js";
import { getLastFridayInboundAt } from "./friday-inbound-stats.js";

const logger = createFridayNextLogger("channel");
const CHANNEL_ID = "friday-next" as const;

function pickFirstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const val = source[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return undefined;
}

/**
 * Resolve the sessionKey for an outbound message-tool send.
 *
 * OpenClaw's `ChannelOutboundContext` does not carry the originating run's sessionKey, so the raw
 * ctx is almost always missing it. We recover the current run's session via the run-route registry
 * (keyed by the device's last tracked runId) so message-tool text/media land in the session that
 * triggered the run — not a device-level fallback. Falls back to the device's latest history session
 * for cron / offline / no-run paths.
 */
function resolveOutboundSessionKey(
  deviceId: string,
  runId: string | undefined,
  rawCtx: Record<string, unknown>,
): string | undefined {
  return (
    (runId ? getRunRoute(runId)?.sessionKey : undefined) ??
    pickFirstString(rawCtx, ["requesterSessionKey", "sessionKey"]) ??
    resolveHistorySessionKeyForFridayDevice(deviceId)
  );
}

function resolveLocalMediaPath(mediaUrl: string, localRoots?: string[]): string {
  if (path.isAbsolute(mediaUrl)) return mediaUrl;
  const roots = localRoots ?? [process.cwd(), os.tmpdir()];
  for (const root of roots) {
    const candidate = path.join(root, mediaUrl);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(process.cwd(), mediaUrl);
}

const fridayConfigAdapter = {
  listAccountIds: () => ["default"],
  resolveAccount: () => ({ accountId: "default", enabled: true }),
  defaultAccountId: () => "default",
  isConfigured: () => true,
  unconfiguredReason: () => null,
  describeAccount: () => ({ accountId: "default", name: "Friday Next Channel", enabled: true }),
};

const fridayMeta = {
  id: CHANNEL_ID,
  label: "Friday Next",
  selectionLabel: "Friday Next (Apple App)",
  docsPath: "/channels/friday-next",
  blurb: "Apple app channel with HTTP + SSE transparent OpenClaw proxy.",
};

const fridayCapabilities = {
  chatTypes: ["direct"] as const,
  markdown: true,
  media: true,
  reactions: false,
  edit: false,
  threads: false,
  polls: false,
  typing: false,
  readReceipts: false,
};

const fridayLifecycle = {
  async onAccountConfigChanged() {
    // No-op
  },
};

const fridayStatus = {
  buildAccountSnapshot: async (params: {
    account: { accountId?: string; name?: string; enabled?: boolean };
    runtime?: ChannelAccountSnapshot;
  }): Promise<ChannelAccountSnapshot> => {
    const { account, runtime } = params;
    const accountId =
      typeof account?.accountId === "string" && account.accountId.trim()
        ? account.accountId.trim()
        : "default";
    const inbound = getLastFridayInboundAt();
    const connected = sseEmitter.getConnectionCount() > 0;
    return {
      accountId,
      name: typeof account?.name === "string" ? account.name : "Friday Next Channel",
      enabled: account?.enabled !== false,
      configured: true,
      running: true,
      connected,
      lastInboundAt: inbound ?? runtime?.lastInboundAt ?? null,
      mode: "http+sse",
    };
  },
};

export const fridayNextChannelPlugin = createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta: fridayMeta,
    actions: {
      describeMessageTool: describeMessageActions,
      handleAction: handleMessageAction,
    },
    capabilities: fridayCapabilities,
    defaults: {
      queue: { debounceMs: 300 },
    },
    config: fridayConfigAdapter,
    lifecycle: fridayLifecycle,
    status: fridayStatus,
    bindings: {
      compileConfiguredBinding: () => null,
      matchInboundConversation: () => null,
      resolveCommandConversation: () => null,
    },
    conversationBindings: {
      supportsCurrentConversationBinding: false,
    },
    messaging: {
      normalizeTarget: (raw: string) => {
        const trimmed = raw?.trim() ?? "";
        return trimmed || "friday-next";
      },
      targetResolver: {
        hint: "Use the deviceId (e.g. your device identifier).",
        resolveTarget: async (ctx: any) => {
          return { to: ctx.normalized };
        },
      },
      parseExplicitTarget: () => ({ to: "friday-next" }),
      formatTargetDisplay: ({ display }: any) => display || "Friday Next",
      // friday-next is a transparent proxy: outbound text/media already reach the app live
      // via SSE (sendText/sendMedia/handleSend). The OpenClaw core additionally mirrors
      // message-tool sends into the recipient's session transcript (model:"delivery-mirror").
      // For friday-next that recipient session falls back to
      // `agent:<agentId>:friday-next:direct:<deviceId>` — an orphan session unrelated to the
      // app's real conversation — spawning a phantom session + a stray delivery-mirror message.
      // The core checks this hook first; returning null short-circuits route resolution so no
      // orphan session entry and no delivery-mirror are written.
      resolveOutboundSessionRoute: () => null,
    },
  },
  outbound: {
    deliveryMode: "direct" as const,
    sendText: async (ctx: any) => {
        const text = ctx.text ?? "";
        const rawCtx = ctx as unknown as Record<string, unknown>;
        const deviceId = resolveFridayDeviceIdForOutbound(ctx.to, rawCtx);
        const runIdFromCtx = pickFirstString(rawCtx, [
          "parentRunId",
          "requesterRunId",
          "originRunId",
          "runId",
        ]);
        const runId = runIdFromCtx ?? sseEmitter.getLastRunIdForDevice(deviceId) ?? undefined;
        const sessionKey = resolveOutboundSessionKey(deviceId, runId, rawCtx);

        const conn = sseEmitter.getConnection(deviceId);
        const ts = new Date().toISOString();
        logger.info(
          `[SEND_TEXT] to=${deviceId} runId=${runId ?? "(none)"} sessionKey=${sessionKey ?? "(none)"} textLen=${text.length} online=${!!conn}`,
        );

        if (conn) {
          sseEmitter.broadcast(
            {
              type: "outbound",
              data: {
                op: "text",
                ts: Date.now(),
                runId,
                deviceId,
                sessionKey,
                ctx: {
                  text,
                  to: ctx.to,
                  mediaUrl: ctx.mediaUrl,
                  audioAsVoice: ctx.audioAsVoice,
                },
              },
            },
            deviceId,
            true,
          );
        }

        return {
          channel: CHANNEL_ID,
          messageId: crypto.randomUUID(),
          timestamp: Date.now(),
        };
      },
      sendMedia: async (ctx: any) => {
        const rawCtx = ctx as unknown as Record<string, unknown>;
        const deviceId = resolveFridayDeviceIdForOutbound(ctx.to, rawCtx);
        const mediaUrl = ctx.mediaUrl;
        const runIdFromCtx = pickFirstString(rawCtx, [
          "parentRunId",
          "requesterRunId",
          "originRunId",
          "runId",
        ]);
        const runId = runIdFromCtx ?? sseEmitter.getLastRunIdForDevice(deviceId) ?? undefined;
        const sessionKey = resolveOutboundSessionKey(deviceId, runId, rawCtx);
        const audioAsVoice = ctx.audioAsVoice === true;
        const caption = ctx.text ?? "";

        if (!mediaUrl) {
          return {
            channel: CHANNEL_ID,
            messageId: crypto.randomUUID(),
            timestamp: Date.now(),
          };
        }

        let buffer: Buffer | null = null;

        if (ctx.mediaReadFile) {
          try {
            buffer = await ctx.mediaReadFile(mediaUrl);
          } catch {
            // fall through to fs
          }
        }

        if (!buffer) {
          try {
            const resolvedPath = resolveLocalMediaPath(mediaUrl, ctx.mediaLocalRoots);
            buffer = fs.readFileSync(resolvedPath);
          } catch {
            // file not found — skip media
          }
        }

        if (buffer) {
          const mimeType = guessMimeType(mediaUrl);
          const saved = await saveMediaBuffer(buffer, mimeType, "inbound");
          if (saved.id) {
            const fileUrl = `/friday-next/files/${encodeURIComponent(saved.id)}`;
            const resolved = resolveMediaAttachment(fileUrl);
            const publicUrl = resolved ? resolved.url : fileUrl;

            const conn = sseEmitter.getConnection(deviceId);
            const ts = new Date().toISOString();
            logger.info(
              `[SEND_MEDIA] to=${deviceId} runId=${runId ?? "(none)"} sessionKey=${sessionKey ?? "(none)"} audioAsVoice=${audioAsVoice} url=${publicUrl} online=${!!conn}`,
            );

            if (conn) {
              sseEmitter.broadcast(
                {
                  type: "outbound",
                  data: {
                    op: "media",
                    ts: Date.now(),
                    runId,
                    deviceId,
                    sessionKey,
                    audioAsVoice,
                    caption,
                    mediaUrl: publicUrl,
                    ctx: {
                      to: ctx.to,
                      text: caption,
                      originalMediaUrl: mediaUrl,
                    },
                  },
                },
                deviceId,
                true,
              );
            }
          }
        }

        return {
          channel: CHANNEL_ID,
          messageId: crypto.randomUUID(),
          timestamp: Date.now(),
        };
      },
  },
});
