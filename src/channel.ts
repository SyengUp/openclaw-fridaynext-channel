/**
 * Friday Channel Plugin Definition.
 *
 * This is a lightweight channel plugin that manages HTTP/SSE connections
 * for the Friday iOS app. Unlike traditional messaging channels, Friday
 * uses a dedicated bidirectional HTTP/SSE protocol instead of polling.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import { saveMediaBuffer } from "openclaw/plugin-sdk/browser-support";
import { sseEmitter } from "./sse/emitter.js";
import { guessMimeType, resolveMediaAttachment } from "./http/handlers/files.js";
import { tryClaimOutboundMediaSource } from "./outbound-media-source-dedupe.js";

function outboundMediaSseType(
  audioAsVoice: boolean,
  resolved: Array<{ fileName: string; url: string }>,
): "tts" | "attachment" {
  if (audioAsVoice) return "tts";
  if (
    resolved.length > 0 &&
    resolved.every((a) => guessMimeType(a.fileName).toLowerCase().startsWith("audio/"))
  ) {
    return "tts";
  }
  return "attachment";
}
import {
  appendAssistantBlock,
  appendLateAssistantText,
  createAssistantOnlyRound,
  getHistory,
} from "./conversation-history.js";
import {
  resolveFridayDeviceIdForOutbound,
  resolveHistorySessionKeyForFridayDevice,
} from "./friday-session.js";

const CHANNEL_ID = "friday" as const;

function pickFirstString(
  source: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const val = source[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return undefined;
}

function resolveLocalMediaPath(mediaUrl: string, localRoots?: string[]): string {
  if (path.isAbsolute(mediaUrl)) return mediaUrl;
  const roots = localRoots ?? [process.cwd(), "/tmp"];
  for (const root of roots) {
    const candidate = path.join(root, mediaUrl);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(process.cwd(), mediaUrl);
}

// ── Config adapter ───────────────────────────────────────────────────────────

const fridayConfigAdapter = {
  listAccountIds: () => ["default"],
  resolveAccount: () => ({ accountId: "default", enabled: true }),
  defaultAccountId: () => "default",
  isConfigured: () => true,
  unconfiguredReason: () => null,
  describeAccount: () => ({ accountId: "default", name: "Friday Channel", enabled: true }),
};

// ── Channel metadata ────────────────────────────────────────────────────────

const fridayMeta = {
  id: CHANNEL_ID,
  label: "Friday",
  selectionLabel: "Friday (iOS)",
  docsPath: "/channels/friday",
  blurb: "Native iOS app channel with full streaming support.",
};

// ── Channel capabilities ─────────────────────────────────────────────────────

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

// ── Lifecycle ───────────────────────────────────────────────────────────────

const fridayLifecycle = {
  async onAccountConfigChanged() {
    // No-op: Friday has no external connection to restart
  },
};

// ── Plugin ───────────────────────────────────────────────────────────────────

export const fridayChannelPlugin = createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta: fridayMeta,
    capabilities: fridayCapabilities,
    defaults: {
      queue: { debounceMs: 300 },
    },
    config: fridayConfigAdapter,
    lifecycle: fridayLifecycle,
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
        return trimmed || "friday";
      },
      targetResolver: {
        hint: "Use the deviceId (e.g. your device identifier).",
        resolveTarget: async (ctx) => {
          // The normalized target IS the deviceId — validate it has an SSE connection.
          // Return the deviceId so ctx.to in sendText/sendMedia is the deviceId.
          return { to: ctx.normalized };
        },
      },
      parseExplicitTarget: () => ({ to: "friday" }),
      formatTargetDisplay: ({ display }) => display || "Friday",
    },
  },
  outbound: {
    base: {
      deliveryMode: "direct" as const,
    },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async (ctx) => {
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
        const sessionKey =
          pickFirstString(rawCtx, [
            "requesterSessionKey",
            "sessionKey",
          ]) ??
          resolveHistorySessionKeyForFridayDevice(deviceId);

        // Persist to disk-backed history whenever we know the session (e.g. cron while app offline).
        // SSE below is optional best-effort when the device is connected.
        if (text && sessionKey) {
          const targetRunId = runId ?? crypto.randomUUID();
          const existing = getHistory(sessionKey)?.rounds.some((r) => r.runId === targetRunId) ?? false;
          if (!existing) {
            createAssistantOnlyRound({ sessionKey, runId: targetRunId });
          }
          appendLateAssistantText({
            sessionKey,
            parentRunId: targetRunId,
            text,
          });
        } else if (text && !sessionKey) {
          const tsSkip = new Date().toISOString();
          console.error(
            `[Friday-OUT] [${tsSkip}] [SEND_TEXT_HISTORY_SKIP] deviceId=${deviceId} textLen=${text.length} detail=no_sessionKey`,
          );
        }

        const conn = sseEmitter.getConnection(deviceId);
        const ts = new Date().toISOString();
        console.error(
          `[Friday-OUT] [${ts}] [SEND_TEXT] to=${deviceId} runId=${runId ?? "(none)"} sessionKey=${sessionKey ?? "(none)"} textLen=${text.length} history=${Boolean(text && sessionKey)} online=${!!conn}`,
        );

        if (conn) {
          const now = Date.now();
          conn.send(
            { type: "final", data: { phase: "start", runId, timestamp: now } },
            true,
          );
          conn.send(
            {
              type: "final",
              data: {
                phase: "delta",
                text,
                runId,
                deviceId,
                mediaUrls: [],
                isError: false,
              },
            },
            true,
          );
          conn.send(
            { type: "final", data: { phase: "end", runId, timestamp: Date.now() } },
            true,
          );
          if (runId) {
            conn.send(
              { type: "run-complete", data: { runId, deviceId } },
              true,
            );
          }
        }

        return {
          channel: CHANNEL_ID,
          messageId: crypto.randomUUID(),
          timestamp: Date.now(),
        };
      },
      sendMedia: async (ctx) => {
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
        const sessionKey =
          pickFirstString(rawCtx, ["requesterSessionKey", "sessionKey"]) ??
          resolveHistorySessionKeyForFridayDevice(deviceId);
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
          if (!tryClaimOutboundMediaSource(runId, mediaUrl)) {
            const tsDup = new Date().toISOString();
            console.error(
              `[Friday-OUT] [${tsDup}] [SEND_MEDIA_SKIP_DUP] to=${deviceId} runId=${runId ?? "(none)"} source=${mediaUrl}`,
            );
          } else {
            const mimeType = guessMimeType(mediaUrl);
            const saved = await saveMediaBuffer(buffer, mimeType, "inbound");
            if (saved.id) {
              const fileUrl = `/friday/files/${encodeURIComponent(saved.id)}`;
              const resolved = resolveMediaAttachment(fileUrl);
              const mediaUrls = resolved ? [resolved.url] : [fileUrl];
              const attachments = resolved ? [resolved] : [];
              const sseType = outboundMediaSseType(audioAsVoice, attachments);

              // History first; SSE only if the app is connected.
              if (sessionKey) {
                const targetRunId = runId ?? crypto.randomUUID();
                const existing = getHistory(sessionKey)?.rounds.some((r) => r.runId === targetRunId) ?? false;
                if (!existing) {
                  createAssistantOnlyRound({ sessionKey, runId: targetRunId });
                }
                appendAssistantBlock({
                  sessionKey,
                  runId: targetRunId,
                  text: caption,
                  mediaUrls,
                  attachments,
                  isError: false,
                  mediaMessageType: sseType,
                });
              } else {
                const tsSkip = new Date().toISOString();
                console.error(
                  `[Friday-OUT] [${tsSkip}] [SEND_MEDIA_HISTORY_SKIP] deviceId=${deviceId} detail=no_sessionKey`,
                );
              }

              const conn = sseEmitter.getConnection(deviceId);
              const ts = new Date().toISOString();
              console.error(
                `[Friday-OUT] [${ts}] [SEND_MEDIA] to=${deviceId} runId=${runId ?? "(none)"} sessionKey=${sessionKey ?? "(none)"} audioAsVoice=${audioAsVoice} url=${fileUrl} history=${Boolean(sessionKey)} online=${!!conn}`,
              );

              if (conn) {
                sseEmitter.broadcast(
                  {
                    type: sseType,
                    data: {
                      attachments,
                      ...(runId ? { runId } : {}),
                      deviceId,
                      timestamp: Date.now(),
                      ...(audioAsVoice ? { audioAsVoice: true } : {}),
                    },
                  },
                  deviceId,
                  true,
                );
              }
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
  },
});
