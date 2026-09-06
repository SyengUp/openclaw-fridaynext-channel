/**
 * Agent-facing attachment send for the current FridayNext conversation.
 *
 * This stays inside the gateway process, so protocol-v3 clients receive the
 * outbound event through their active durable run. Spawning the standalone
 * `openclaw message send` CLI loads another plugin process that cannot see the
 * gateway's live v3 store or listeners.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveMediaMaxBytes } from "../agent/media-bridge.js";
import {
  guessMimeType,
  normalizeAgentMediaPath,
  resolveMediaAttachment,
} from "../http/handlers/files.js";
import {
  deviceUsesPublicSurface,
  encryptOutboundBufferToFnoss,
} from "../public-access/outbound-media-oss.js";
import { sseEmitter } from "../sse/emitter.js";
import { resolveDeviceToolRoute } from "./device-tool-route.js";

export const SEND_FILE_TOOL_NAME = "fridaynext_send_file";

export const SEND_FILE_TOOL_DESCRIPTION =
  "Send one local file from the OpenClaw gateway host into the current FridayNext conversation as an attachment. Call this when the user asks you to send, attach, or return a local image, document, audio file, video, archive, or other file they mention by path. The path may be absolute, file://, or start with ~/. Use this tool for FridayNext attachments; do not run the standalone `openclaw message send` CLI, because that separate process cannot deliver into the current protocol-v3 conversation.";

const SendFileParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      description: "Local file path on the OpenClaw gateway host.",
    },
    caption: {
      type: "string",
      description: "Optional short caption associated with the attachment.",
    },
  },
  required: ["path"],
} as const;

function jsonToolResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

export function createSendFileTool(ctx: { sessionKey?: string }): {
  name: string;
  label: string;
  description: string;
  parameters: typeof SendFileParameters;
  execute: (
    _toolCallId: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
} {
  return {
    name: SEND_FILE_TOOL_NAME,
    label: "FridayNext Send File",
    description: SEND_FILE_TOOL_DESCRIPTION,
    parameters: SendFileParameters,
    async execute(_toolCallId, args) {
      const route = resolveDeviceToolRoute(ctx.sessionKey);
      if (!route) {
        return jsonToolResult({
          ok: false,
          error: {
            code: "SEND_FILE_NO_CONVERSATION",
            message: "No FridayNext conversation is associated with this run",
          },
        });
      }
      if (!route.runId) {
        return jsonToolResult({
          ok: false,
          error: {
            code: "SEND_FILE_NO_ACTIVE_RUN",
            message: "No active FridayNext run can receive this attachment",
          },
        });
      }

      const requestedPath = stringArg(args, "path");
      const localPath = normalizeAgentMediaPath(requestedPath);
      if (!localPath) {
        return jsonToolResult({
          ok: false,
          error: { code: "SEND_FILE_PATH_REQUIRED", message: "path is required" },
        });
      }

      let size: number;
      try {
        const stat = fs.statSync(localPath);
        if (!stat.isFile()) throw new Error("not a file");
        size = stat.size;
      } catch {
        return jsonToolResult({
          ok: false,
          error: {
            code: "SEND_FILE_NOT_FOUND",
            message: `File is missing or unreadable: ${requestedPath}`,
          },
        });
      }

      const filename = path.basename(localPath) || "attachment";
      const mimeType = guessMimeType(filename);
      const maxBytes = await resolveMediaMaxBytes(mimeType);
      if (maxBytes !== undefined && size > maxBytes) {
        return jsonToolResult({
          ok: false,
          error: {
            code: "SEND_FILE_TOO_LARGE",
            message: `File is ${size} bytes; the ${mimeType} limit is ${maxBytes} bytes`,
          },
        });
      }

      const attachment = resolveMediaAttachment(localPath);
      if (!attachment) {
        return jsonToolResult({
          ok: false,
          error: {
            code: "SEND_FILE_COPY_FAILED",
            message: `Could not prepare attachment: ${requestedPath}`,
          },
        });
      }

      const caption = stringArg(args, "caption");
      const fnoss = deviceUsesPublicSurface(route.deviceId)
        ? await encryptOutboundBufferToFnoss(
            fs.readFileSync(localPath),
            { name: attachment.fileName, mime: mimeType },
            route.deviceId,
          )
        : null;
      sseEmitter.broadcast(
        {
          type: "outbound",
          data: {
            op: "media",
            ts: Date.now(),
            runId: route.runId,
            deviceId: route.deviceId,
            sessionKey: route.sessionKey,
            audioAsVoice: false,
            caption,
            mediaUrl: fnoss ?? attachment.url,
            ctx: {
              to: route.deviceId,
              text: caption,
              originalMediaUrl: localPath,
            },
          },
        },
        route.deviceId,
        true,
      );

      return jsonToolResult({
        ok: true,
        filename: attachment.fileName,
        mimeType,
        size,
      });
    },
  };
}
