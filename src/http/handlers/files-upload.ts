/**
 * File upload handler for POST /friday-next/files
 *
 * Handles multipart file uploads from the iOS app.
 * Stores files and returns file IDs that can be referenced in messages.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { extractBearerToken } from "../middleware/auth.js";
import {
  getAttachmentsDir,
  storeFile,
  storeFileWithStableId,
  guessMimeType,
  type StoredFile,
} from "./files.js";

export class IdempotentUploadConflictError extends Error {}

type DurableUploadRecord = {
  deviceId: string;
  clientAttachmentId: string;
  sha256: string;
  stableId: string;
  filename: string;
  mimeType: string;
};

export function storeIdempotentUpload(params: {
  deviceId: string;
  clientAttachmentId: string;
  sha256: string;
  buffer: Buffer;
  filename: string;
  mimeType: string;
}): StoredFile {
  const deviceId = params.deviceId.trim().toUpperCase();
  const clientAttachmentId = params.clientAttachmentId.trim();
  const claimedHash = params.sha256.trim().toLowerCase();
  const actualHash = crypto.createHash("sha256").update(params.buffer).digest("hex");
  if (!deviceId || !clientAttachmentId || !/^[a-f0-9]{64}$/.test(claimedHash)) {
    throw new Error("deviceId, clientAttachmentId and sha256 are required");
  }
  if (actualHash !== claimedHash) throw new Error("sha256 does not match uploaded bytes");

  const requestKey = crypto
    .createHash("sha256")
    .update(`${deviceId}\0${clientAttachmentId}`)
    .digest("hex");
  const ledgerPath = path.join(getAttachmentsDir(), `.upload-${requestKey}.json`);
  const existing: DurableUploadRecord | null = (() => {
    try {
      return JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as DurableUploadRecord;
    } catch {
      return null;
    }
  })();
  if (existing) {
    if (existing.sha256 !== claimedHash) {
      throw new IdempotentUploadConflictError(
        "clientAttachmentId was already used with different bytes",
      );
    }
    return storeFileWithStableId(
      params.buffer,
      existing.filename,
      existing.mimeType,
      existing.stableId,
    );
  }

  const record: DurableUploadRecord = {
    deviceId,
    clientAttachmentId,
    sha256: claimedHash,
    stableId: requestKey.slice(0, 32),
    filename: path.basename(params.filename) || "file",
    mimeType: params.mimeType,
  };
  const stored = storeFileWithStableId(
    params.buffer,
    record.filename,
    record.mimeType,
    record.stableId,
  );
  const temporaryPath = `${ledgerPath}.${process.pid}.tmp`;
  const descriptor = fs.openSync(temporaryPath, "w", 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(record));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, ledgerPath);
  return stored;
}

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

  const pathname = new URL(req.url ?? "/friday-next/files", "http://localhost").pathname;
  const isProtocolV3 = pathname === "/friday-next/v3/files";
  if (
    isProtocolV3 &&
    (!parsed.fields.deviceId ||
      !parsed.fields.clientAttachmentId ||
      !parsed.fields.sha256 ||
      parsed.files.length !== 1)
  ) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: "v3 upload requires one file, deviceId, clientAttachmentId and sha256",
      }),
    );
    return true;
  }

  let files: Array<{
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    url: string;
  }>;
  try {
    files = parsed.files.map((file) => {
      const stored = isProtocolV3
        ? storeIdempotentUpload({
            deviceId: parsed.fields.deviceId,
            clientAttachmentId: parsed.fields.clientAttachmentId,
            sha256: parsed.fields.sha256,
            buffer: file.buffer,
            filename: file.filename,
            mimeType: file.contentType,
          })
        : storeFile(file.buffer, file.filename, file.contentType);
      return {
        id: stored.id,
        filename: stored.filename,
        mimeType: stored.mimeType,
        size: stored.size,
        url: `/friday-next/files/${encodeURIComponent(stored.urlToken)}`,
      };
    });
  } catch (error) {
    res.statusCode = error instanceof IdempotentUploadConflictError ? 409 : 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: String(error instanceof Error ? error.message : error) }));
    return true;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ files }));
  return true;
}
