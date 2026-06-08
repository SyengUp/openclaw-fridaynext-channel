import crypto from "node:crypto";
import fs from "node:fs";
import { sseEmitter } from "./sse/emitter.js";
import { guessMimeType } from "./http/handlers/files.js";
import { decodeBase64Media, downloadRemoteMedia, isHttpUrl } from "./media-fetch.js";
import { getRunRoute } from "./run-metadata.js";
import { resolveHistorySessionKeyForFridayDevice } from "./friday-session.js";

type MessageActionCtx = {
  action: string;
  params: Record<string, unknown>;
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  sessionKey?: string | null;
  requesterSenderId?: string | null;
};

const DISCOVERY = {
  actions: ["send", "channel-info", "channel-list"] as const,
  capabilities: ["text", "media"] as const,
};

const CHANNEL_INFO_RESPONSE = {
  ok: true as const,
  channels: [{ id: "friday-next", name: "Friday Next", transport: "http+sse" }],
};

export function describeMessageActions() {
  return DISCOVERY;
}

function pickString(params: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = params[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

async function readMediaFile(
  mediaPath: string,
  ctx: MessageActionCtx,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  if (isHttpUrl(mediaPath)) {
    return downloadRemoteMedia(mediaPath);
  }
  if (ctx.mediaReadFile) {
    try {
      const buffer = await ctx.mediaReadFile(mediaPath);
      if (buffer?.length) {
        return { buffer, mimeType: guessMimeType(mediaPath) };
      }
    } catch { /* fall through */ }
  }
  try {
    const buffer = fs.readFileSync(mediaPath);
    return { buffer, mimeType: guessMimeType(mediaPath) };
  } catch {
    return null;
  }
}

async function handleSend(ctx: MessageActionCtx): Promise<unknown> {
  const to = pickString(ctx.params, ["to", "target"]).toUpperCase();
  const text = pickString(ctx.params, ["message", "text", "content"]);
  const mediaPath = pickString(ctx.params, ["media", "url", "path", "filePath", "fileUrl"]);
  const inlineBase64 = pickString(ctx.params, ["buffer", "base64", "data"]);
  const mediaMimeHint = pickString(ctx.params, ["mimeType", "contentType"]);
  const filename = pickString(ctx.params, ["filename", "name"]);
  const caption = pickString(ctx.params, ["caption"]);

  if (!to) {
    return { ok: false, error: "Missing required param: to" };
  }

  const runId = crypto.randomUUID();
  // The `message` tool's send runs as a fresh action; `ctx.sessionKey` is the agent's base/main
  // session, not the app session that started the active run on this device. Recover the latter via
  // the device's last tracked run-route so attachments land in the user's current session.
  const activeRunId = sseEmitter.getLastRunIdForDevice(to) ?? undefined;
  const sessionKey =
    (activeRunId ? getRunRoute(activeRunId)?.sessionKey : undefined) ??
    ctx.sessionKey ??
    resolveHistorySessionKeyForFridayDevice(to);

  // Send text via SSE outbound
  if (text) {
    sseEmitter.broadcast(
      {
        type: "outbound",
        data: {
          op: "text",
          ts: Date.now(),
          runId,
          deviceId: to,
          sessionKey,
          ctx: { text, to },
        },
      },
      to,
      true,
    );
  }

  // Resolve media from an inline base64 buffer or a path/url reference. (`attachments[]` arrays are
  // normalized by the OpenClaw core and arrive via outbound.sendMedia, so they're not handled here.)
  let media: { buffer: Buffer; mimeType: string } | null = null;
  let originalMediaUrl = "";
  if (inlineBase64) {
    media = decodeBase64Media(
      inlineBase64,
      mediaMimeHint || (filename ? guessMimeType(filename) : ""),
    );
    originalMediaUrl = filename || "inline-buffer";
  } else if (mediaPath) {
    media = await readMediaFile(mediaPath, ctx);
    originalMediaUrl = mediaPath;
  }

  // Send media via SSE outbound
  if (media) {
    const { saveMediaBuffer } = await import("openclaw/plugin-sdk/media-store");
    const saved = await saveMediaBuffer(media.buffer, media.mimeType, "inbound");
    if (saved.id) {
      const publicUrl = `/friday-next/files/${encodeURIComponent(saved.id)}`;
      sseEmitter.broadcast(
        {
          type: "outbound",
          data: {
            op: "media",
            ts: Date.now(),
            runId,
            deviceId: to,
            sessionKey,
            audioAsVoice: false,
            caption: caption || text,
            mediaUrl: publicUrl,
            ctx: { to, text: caption || text, originalMediaUrl },
          },
        },
        to,
        true,
      );
    }
  }

  return { ok: true, runId, to };
}

export async function handleMessageAction(ctx: MessageActionCtx): Promise<unknown> {
  if (ctx.action === "channel-info" || ctx.action === "channel-list") {
    return CHANNEL_INFO_RESPONSE;
  }
  if (ctx.action === "send") {
    return handleSend(ctx);
  }
  return null;
}
