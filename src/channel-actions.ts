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

function pickStringArray(params: Record<string, unknown>, key: string): string[] {
  const v = params[key];
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of v) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
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
    } catch {
      /* fall through */
    }
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

  // Resolve the media to send. A `message` tool call with a structured `attachments[]` array is
  // flattened by the OpenClaw core into `params.mediaUrls` (with `media` set to the first entry for
  // back-compat), so prefer the full list; fall back to a single inline base64 buffer or a
  // path/url reference for the single-attachment / direct-link / buffer cases.
  const mediaSources: { buffer: Buffer; mimeType: string; originalMediaUrl: string }[] = [];
  const mediaUrls = pickStringArray(ctx.params, "mediaUrls");
  if (mediaUrls.length > 0) {
    for (const ref of mediaUrls) {
      const loaded = await readMediaFile(ref, ctx);
      if (loaded) mediaSources.push({ ...loaded, originalMediaUrl: ref });
    }
  } else if (inlineBase64) {
    const loaded = decodeBase64Media(
      inlineBase64,
      mediaMimeHint || (filename ? guessMimeType(filename) : ""),
    );
    if (loaded) mediaSources.push({ ...loaded, originalMediaUrl: filename || "inline-buffer" });
  } else if (mediaPath) {
    const loaded = await readMediaFile(mediaPath, ctx);
    if (loaded) mediaSources.push({ ...loaded, originalMediaUrl: mediaPath });
  }

  // Send each media via its own SSE outbound event. They all share this send's `runId` so the app
  // groups them into a single assistant message (first → attachment, rest → extra attachments).
  if (mediaSources.length > 0) {
    const { saveMediaBuffer } = await import("openclaw/plugin-sdk/media-store");
    for (const source of mediaSources) {
      const saved = await saveMediaBuffer(source.buffer, source.mimeType, "inbound");
      if (!saved.id) continue;
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
            ctx: { to, text: caption || text, originalMediaUrl: source.originalMediaUrl },
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
