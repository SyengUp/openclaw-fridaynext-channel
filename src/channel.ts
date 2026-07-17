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
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-lifecycle";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { createFridayNextLogger } from "./logging.js";
import { encryptOutboundBufferToFnoss } from "./public-access/outbound-media-oss.js";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { sseEmitter } from "./sse/emitter.js";
import { fridayNotificationsStore } from "./notifications/notifications-store.js";
import { resolveBackgroundPushKind } from "./notifications/background-push-kind.js";
import { describeMessageActions, handleMessageAction } from "./channel-actions.js";
import { guessMimeType, resolveMediaAttachment } from "./http/handlers/files.js";
import { downloadRemoteMedia, isHttpUrl } from "./media-fetch.js";
import { resolveMediaMaxBytes } from "./agent/media-bridge.js";
import {
  resolveFridayDeviceIdForOutbound,
  resolveHistorySessionKeyForFridayDevice,
  getLastRegisteredFridayDeviceId,
} from "./friday-session.js";
import { getRunRoute } from "./run-metadata.js";
import { isOperatorToolResultEnvelope } from "./operator-tool-result.js";
import { getLastFridayInboundAt } from "./friday-inbound-stats.js";
import { fridayApprovalCapability } from "./approval/friday-approval-capability.js";

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
  // Isolated cron / background pushes reach the core's outbound target resolver with no `to`
  // (friday-next intentionally returns null from resolveOutboundSessionRoute to avoid phantom
  // delivery-mirror sessions, so the session bucket never stores a routable friday-next target).
  // Without a default the core aborts with "Delivering to Friday Next requires target" before
  // sendText's own device fallback ever runs. Surface the same device fallback here — the sole
  // connected device, else the last device that POSTed — so target resolution passes and sendText
  // does the precise per-device routing (and still writes fridayNotificationsStore when offline).
  // Returns undefined only when the device is genuinely ambiguous (multiple/none known), which
  // correctly keeps the explicit-`--to` requirement for that case. The last-seen fallback is
  // disk-persisted (see friday-session.ts) so it survives gateway restarts with the app offline.
  resolveDefaultTo: (): string | undefined => {
    const sole = sseEmitter.getSoleConnectedDeviceId();
    const resolved = sole ?? getLastRegisteredFridayDeviceId() ?? undefined;
    if (resolved) {
      logger.info(
        `[DEFAULT_TO] implicit target -> ${resolved} (${sole ? "sole-connected" : "last-seen"})`,
      );
    } else {
      logger.warn(
        "[DEFAULT_TO] no implicit target: no connected device and no persisted last-seen device",
      );
    }
    return resolved;
  },
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

/**
 * friday-next is a passive HTTP+SSE channel: its routes live on the shared gateway server and
 * SSE clients connect on demand, so there is no per-account socket or polling loop to maintain.
 * But the core health-monitor reads the account's lifecycle `running` flag — which the framework
 * flips to `false` the moment `startAccount` resolves/rejects. Without a long-lived startAccount
 * the account is permanently seen as "stopped" and restarted every health poll (~5 min). A stopped
 * account drops out of the deliverable-channel registry, so an agent `message` send landing in that
 * window fails with `Unknown channel: friday-next`. Hold the account lifecycle open until abort
 * (reload/shutdown) so the channel stays `running:true` and continuously deliverable.
 */
const fridayGateway = {
  startAccount: async (ctx: ChannelGatewayContext): Promise<void> => {
    // Activate exec/plugin approval delivery to the app. The gateway's approval-handler bootstrap
    // only wires up our `approvalCapability` once the channel registers an "approval.native" runtime
    // context (the registration event is the gate — without it approvals silently skip friday-next
    // and only reach ControlUI). friday-next's nativeRuntime needs no per-account state — it resolves
    // the target device from each request's sessionKey via global singletons — so context is empty.
    if (ctx.channelRuntime) {
      registerChannelRuntimeContext({
        channelRuntime: ctx.channelRuntime,
        channelId: CHANNEL_ID,
        accountId: ctx.accountId,
        capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
        context: {},
        abortSignal: ctx.abortSignal,
      });
    }
    await waitUntilAbort(ctx.abortSignal);
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
    gateway: fridayGateway,
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

      // Silence core operator/admin tool-result receipts (gateway.restart, config
      // mutations, …). They deliver on the user's normal main session and are
      // indistinguishable by session key / kind / agentId from a real reply, so the
      // text envelope is the only discriminator (see operator-tool-result.ts). These
      // infra confirmations carry no reading value: skip BOTH the durable notification
      // AND the live SSE broadcast — full silence.
      if (isOperatorToolResultEnvelope(text)) {
        logger.info(
          `[SEND_TEXT] suppressed operator tool-result receipt to=${deviceId} textLen=${text.length}`,
        );
        return {
          channel: CHANNEL_ID,
          messageId: crypto.randomUUID(),
          timestamp: Date.now(),
        };
      }

      const runIdFromCtx = pickFirstString(rawCtx, [
        "parentRunId",
        "requesterRunId",
        "originRunId",
        "runId",
      ]);
      const runId = runIdFromCtx ?? sseEmitter.getLastRunIdForDevice(deviceId) ?? undefined;
      const sessionKey = resolveOutboundSessionKey(deviceId, runId, rawCtx);

      const conn = sseEmitter.getConnection(deviceId);

      // Durable notification capture for agent-initiated background pushes
      // (cron/heartbeat). Written BEFORE the connection gate so an offline device
      // still surfaces it on next reconnect. Key classification alone misses REAL
      // cron deliveries (the core passes no origin identity, so sessionKey resolves
      // to a device/history key, never `:cron:`) — when the device is offline the
      // send cannot reach it live, so capture it as a "push". If a scheduled task
      // fired within the correlation window we attribute it to that cron by name.
      // Cron/heartbeat background pushes are captured REGARDLESS of connection — the inbox is
      // their durable record, so a lost live delivery (SSE flap / backgrounded app) can't drop
      // them. A normal reply is captured only when offline.
      const bg = resolveBackgroundPushKind();
      fridayNotificationsStore.append({
        deviceId,
        ts: Date.now(),
        sourceSessionKey: sessionKey,
        text,
        hasMedia: false,
        fallbackKind: bg.kind ?? (conn ? null : "push"),
        jobId: bg.cron?.jobId,
        jobName: bg.cron?.name,
        originAgentId: bg.agentId,
      });
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

      // Durable notification capture; before any gate. Same offline "push" fallback
      // as sendText — real cron deliveries never carry a `:cron:` session key, so a
      // recently-fired scheduled task lends the push its name.
      const bgForMedia = resolveBackgroundPushKind();
      fridayNotificationsStore.append({
        deviceId,
        ts: Date.now(),
        sourceSessionKey: sessionKey,
        text: caption,
        hasMedia: true,
        fallbackKind: bgForMedia.kind ?? (sseEmitter.getConnection(deviceId) ? null : "push"),
        jobId: bgForMedia.cron?.jobId,
        jobName: bgForMedia.cron?.name,
        originAgentId: bgForMedia.agentId,
      });

      if (!mediaUrl) {
        return {
          channel: CHANNEL_ID,
          messageId: crypto.randomUUID(),
          timestamp: Date.now(),
        };
      }

      let buffer: Buffer | null = null;
      let downloadedMimeType: string | null = null;

      if (ctx.mediaReadFile) {
        try {
          buffer = await ctx.mediaReadFile(mediaUrl);
        } catch {
          // fall through to remote download / fs
        }
      }

      if (!buffer && isHttpUrl(mediaUrl)) {
        const remote = await downloadRemoteMedia(mediaUrl);
        if (remote) {
          buffer = remote.buffer;
          downloadedMimeType = remote.mimeType;
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
        const mimeType = downloadedMimeType ?? guessMimeType(mediaUrl);
        // Match what openclaw itself supports for this media kind rather than
        // saveMediaBuffer's 5MB default.
        const maxBytes = await resolveMediaMaxBytes(mimeType);
        const saved = await saveMediaBuffer(buffer, mimeType, "inbound", maxBytes);
        if (saved.id) {
          const fileUrl = `/friday-next/files/${encodeURIComponent(saved.id)}`;
          const resolved = resolveMediaAttachment(fileUrl);
          const tunnelUrl = resolved ? resolved.url : fileUrl;
          // Phase E (E-wire ③): divert the message-tool media send off the relay tunnel — encrypt +
          // upload to OSS and hand the app a `fnoss:v1:…` ref instead. No-op / graceful fallback to
          // the tunnel URL when public access is off or the upload fails.
          const fnoss = await encryptOutboundBufferToFnoss(buffer, {
            name: path.basename(mediaUrl) || "attachment",
            mime: mimeType,
          });
          const publicUrl = fnoss ?? tunnelUrl;

          const conn = sseEmitter.getConnection(deviceId);
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

// Attach exec/plugin approval delivery to the app. `createChatChannelPlugin` has no config slot for
// it, so it's set on the returned plugin object; setting it auto-registers the native approval
// handler via the gateway's approval bootstrap. Additive with ControlUI (no forwarding suppressor).
fridayNextChannelPlugin.approvalCapability = fridayApprovalCapability;
