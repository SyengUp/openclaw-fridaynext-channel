/**
 * File download handler for GET /friday-next/files/:id
 *
 * Sources checked (in order):
 * 1. In-memory file index (POST /friday-next/files and resolved attachments this session)
 * 2. Plugin-root `attachments/` on disk (same basename as URL token; survives restarts)
 * 3. OpenClaw media buffer (~/.openclaw/media/inbound/<id>)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken } from "../middleware/auth.js";
import {
  getExternalFileSourceByUrlToken,
  getFile,
  guessMimeType,
  readAttachmentFileFromDisk,
  readFile,
} from "./files.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const MIME_FROM_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/opus",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
};

function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: message }));
}

/** Avoid decodeURIComponent throwing on malformed % sequences (would surface as 500). */
function tryDecodeURIComponent(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Safe Content-Disposition: strip CR/LF/quotes from basename; add RFC 5987 filename* for Unicode.
 */
function contentDispositionInline(filename: string): string {
  const base =
    path.basename(filename).replace(/[\r\n"]/g, "_").replace(/\\/g, "_") || "file";
  const ascii = /^[\x20-\x7E]*$/.test(base) ? base : "file";
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

/**
 * Full-body or single-range 206 response. iOS/Safari often sends Range for JPEG; proxies may error if mishandled.
 */
function sendBuffer(
  req: IncomingMessage,
  res: ServerResponse,
  buffer: Buffer,
  mimeType: string,
  filename: string,
): void {
  const total = buffer.length;
  const disposition = contentDispositionInline(filename);
  const rangeRaw = req.headers.range;
  const range =
    typeof rangeRaw === "string" && /^bytes=/i.test(rangeRaw.trim())
      ? rangeRaw.trim()
      : undefined;

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Disposition", disposition);

  if (!range || total === 0) {
    res.statusCode = 200;
    res.setHeader("Content-Length", String(total));
    res.end(buffer);
    return;
  }

  const m = /^bytes=(\d*)-(\d*)$/i.exec(range);
  if (!m) {
    res.statusCode = 200;
    res.setHeader("Content-Length", String(total));
    res.end(buffer);
    return;
  }

  let start = 0;
  let end = total - 1;

  if (m[1] === "" && m[2] !== "") {
    const suffixLen = parseInt(m[2]!, 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) {
      res.statusCode = 200;
      res.setHeader("Content-Length", String(total));
      res.end(buffer);
      return;
    }
    start = Math.max(0, total - suffixLen);
    end = total - 1;
  } else if (m[1] !== "" && m[2] === "") {
    start = parseInt(m[1]!, 10);
    end = total - 1;
  } else if (m[1] !== "" && m[2] !== "") {
    start = parseInt(m[1]!, 10);
    end = parseInt(m[2]!, 10);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    res.statusCode = 416;
    res.setHeader("Content-Range", `bytes */${total}`);
    res.end();
    return;
  }
  if (end >= total) end = total - 1;
  const chunk = buffer.subarray(start, end + 1);
  res.statusCode = 206;
  res.setHeader("Content-Length", String(chunk.length));
  res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
  res.end(chunk);
}

export async function handleFilesDownload(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  try {
    if (req.method !== "GET") {
      sendError(res, 405, "Method Not Allowed");
      return true;
    }

    if (!extractBearerToken(req)) {
      sendError(res, 401, "Unauthorized");
      return true;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      sendError(res, 400, "Bad request URL");
      return true;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    const rawSeg = segments[segments.length - 1] ?? "";
    const fileToken = tryDecodeURIComponent(rawSeg);
    if (fileToken === null) {
      sendError(res, 400, "Invalid file path encoding");
      return true;
    }

    if (!fileToken || fileToken === "files") {
      sendError(res, 400, "Missing file ID");
      return true;
    }

    // 1. Try Friday's own in-memory file index
    const file = getFile(fileToken);
    if (file) {
      const { buffer, mimeType } = readFile(fileToken);
      if (buffer) {
        sendBuffer(req, res, buffer, mimeType, file.filename);
        return true;
      }
    }

    // 1.2 Plugin-root attachments/ (survives gateway restarts; basename = URL token)
    const fromAttachments = readAttachmentFileFromDisk(fileToken);
    if (fromAttachments) {
      sendBuffer(req, res, fromAttachments.buffer, fromAttachments.mimeType, fromAttachments.filename);
      return true;
    }

    // 1.4 Best-effort external source by token (when copy-to-attachments failed earlier)
    const externalSource = getExternalFileSourceByUrlToken(fileToken);
    if (externalSource && fs.existsSync(externalSource)) {
      try {
        const buffer = fs.readFileSync(externalSource);
        const filename = path.basename(externalSource);
        sendBuffer(req, res, buffer, guessMimeType(filename), filename);
        return true;
      } catch {
        // continue fallback chain
      }
    }

    // 2. Try OpenClaw media buffer (~/.openclaw/media/inbound/<id>)
    // fileId may include an extension (e.g. "uuid.png") — strip it to get the base id
    const baseId = fileToken.replace(/\.[^.]+$/, "");
    const mediaDir = path.join(os.homedir(), ".openclaw", "media", "inbound");
    const candidates = [
      path.join(mediaDir, baseId),
      path.join(mediaDir, fileToken),
    ];

    for (const filePath of candidates) {
      if (fs.existsSync(filePath)) {
        try {
          const st = fs.statSync(filePath);
          if (!st.isFile()) continue;
          const buffer = fs.readFileSync(filePath);
          const ext = path.extname(fileToken).toLowerCase().replace(/^\./, "");
          const mimeType = MIME_FROM_EXT[ext] ?? "application/octet-stream";
          sendBuffer(req, res, buffer, mimeType, fileToken);
          return true;
        } catch {
          // fall through to 404
        }
      }
    }

    sendError(res, 404, "File not found");
    return true;
  } catch (err) {
    console.error(`[Friday-FILES] GET download failed: ${String(err)}`);
    sendError(res, 500, "Internal Server Error");
    return true;
  }
}
