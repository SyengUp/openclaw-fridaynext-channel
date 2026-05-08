import crypto from "node:crypto";
import fs from "node:fs";
import { sseEmitter } from "./sse/emitter.js";
import { guessMimeType } from "./http/handlers/files.js";

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
  const mediaPath = pickString(ctx.params, ["media", "path", "filePath", "fileUrl"]);
  const caption = pickString(ctx.params, ["caption"]);

  if (!to) {
    return { ok: false, error: "Missing required param: to" };
  }

  const runId = crypto.randomUUID();
  const sessionKey = ctx.sessionKey ?? undefined;

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

  // Send media via SSE outbound
  if (mediaPath) {
    const result = await readMediaFile(mediaPath, ctx);
    if (result) {
      const { saveMediaBuffer } = await import("openclaw/plugin-sdk/media-store");
      const saved = await saveMediaBuffer(result.buffer, result.mimeType, "inbound");
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
              ctx: { to, text: caption || text, originalMediaUrl: mediaPath },
            },
          },
          to,
          true,
        );
      }
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
