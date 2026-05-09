/**
 * File upload handler for POST /friday-next/files
 *
 * Handles multipart file uploads from the iOS app.
 * Stores files and returns file IDs that can be referenced in messages.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken } from "../middleware/auth.js";
import { storeFile, guessMimeType } from "./files.js";

interface ParsedMultipart {
  fields: Record<string, string>;
  files: Array<{ filename: string; buffer: Buffer; contentType: string }>;
}

async function parseMultipartBody(
  req: IncomingMessage,
  boundaryContentType: string,
): Promise<ParsedMultipart | null> {
  const boundaryMatch = boundaryContentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) return null;
  const boundary = boundaryMatch[1] ?? boundaryMatch[2];
  if (!boundary) return null;

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", resolve);
    req.on("error", reject);
  });

  const body = Buffer.concat(chunks);
  const parts: ParsedMultipart = { fields: {}, files: [] };

  const boundaryBuffer = Buffer.from(`--${boundary}`);

  let start = 0;
  while (start < body.length) {
    const idx = bufferIndexOf(body, boundaryBuffer, start);
    if (idx === -1) break;

    const nextStart = idx + boundaryBuffer.length;
    if (body[nextStart] === 0x2d && body[nextStart + 1] === 0x2d) {
      // "--" after boundary = end
      break;
    }
    if (body[nextStart] !== 0x0d || body[nextStart + 1] !== 0x0a) {
      start = nextStart;
      continue;
    }

    const headerEnd = bufferIndexOf(body, Buffer.from("\r\n\r\n"), nextStart + 2);
    if (headerEnd === -1) {
      start = nextStart;
      continue;
    }

    const headers = body.subarray(idx + boundaryBuffer.length + 2, headerEnd).toString("utf-8");
    const contentDisposition = extractHeaderValue(headers, "Content-Disposition");
    const contentTypeHeader = extractHeaderValue(headers, "Content-Type");

    const filenameMatch = contentDisposition?.match(/filename="([^"]+)"/);
    const nameMatch = contentDisposition?.match(/name="([^"]+)"/);
    const filename = filenameMatch?.[1] ?? nameMatch?.[1] ?? "file";
    const isFile = Boolean(filenameMatch);

    const dataStart = headerEnd + 4;
    // Search for the closing boundary marker (\r\n--boundary) rather than just
    // \r\n, since binary file data may contain CRLF bytes.
    const closingBoundary = Buffer.from(`\r\n--${boundary}`);
    const endIdx = bufferIndexOf(body, closingBoundary, dataStart);
    const end = endIdx === -1 ? body.length - 2 : endIdx;

    if (isFile) {
      const buffer = body.subarray(dataStart, end);
      const mimeType = contentTypeHeader ?? guessMimeType(filename);
      parts.files.push({ filename, buffer, contentType: mimeType });
    } else if (nameMatch) {
      const value = body.subarray(dataStart, end).toString("utf-8").trim();
      parts.fields[nameMatch[1]] = value;
    }

    start = end + 2;
  }

  return parts;
}

function extractHeaderValue(headers: string, name: string): string | undefined {
  const lines = headers.split(/\r\n/);
  for (const line of lines) {
    const [key, ...valueParts] = line.split(":");
    if (key.trim().toLowerCase() === name.toLowerCase()) {
      return valueParts.join(":").trim();
    }
  }
  return undefined;
}

function bufferIndexOf(haystack: Buffer, needle: Buffer, start = 0): number {
  for (let i = start; i <= haystack.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

export async function handleFilesUpload(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return true;
  }

  const token = extractBearerToken(req);
  if (!token) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Unauthorized: bearer token mismatch" }));
    return true;
  }

  const contentType = req.headers["content-type"] ?? "";
  const parsed = await parseMultipartBody(req, contentType);

  if (!parsed) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Invalid multipart form data" }));
    return true;
  }

  if (parsed.files.length === 0) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "No files provided" }));
    return true;
  }

  const files = parsed.files.map((file) => {
    const stored = storeFile(file.buffer, file.filename, file.contentType);
    return {
      id: stored.id,
      filename: stored.filename,
      mimeType: stored.mimeType,
      size: stored.size,
      url: `/friday-next/files/${encodeURIComponent(stored.urlToken)}`,
    };
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ files }));
  return true;
}
