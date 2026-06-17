/**
 * File manager for Friday Next channel attachments.
 *
 * Files are copied under `~/.openclaw/friday-next/attachments/` and served at
 * GET /friday-next/files/{token} so the app can use stable gateway URLs after restarts.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { createFridayNextLogger } from "../../logging.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFridayNextConfig } from "../../config.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { getFridayNextRuntime } from "../../runtime.js";

/** Test-only override for the attachments base directory. */
let testAttachmentsDir: string | null = null;

export function setAttachmentsDirForTest(dir: string | null): void {
  testAttachmentsDir = dir;
}

/** Resolve `<historyDir>/../attachments`, mirroring the offline-queue layout. */
function resolveAttachmentsDir(): string {
  try {
    const cfg = resolveFridayNextConfig(
      getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
    );
    return path.join(path.dirname(cfg.historyDir), "attachments");
  } catch {
    return path.join(os.homedir(), ".openclaw", "friday-next", "attachments");
  }
}

/** `~/.openclaw/friday-next/attachments/` directory; created on first use. */
export function getAttachmentsDir(): string {
  const dir = testAttachmentsDir ?? resolveAttachmentsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Already exists or permission denied
  }
  return dir;
}

export interface StoredFile {
  id: string;
  /** Path segment for /friday-next/files/{urlToken} (on-disk basename under attachments/). */
  urlToken: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: number;
}

/** In-memory index of stored files (keys: uuid id and urlToken / disk basename). */
const fileIndex = new Map<string, StoredFile>();
const fileTokenIndex = new Map<string, StoredFile>();
const externalFileSourceIndex = new Map<string, string>();

const logger = createFridayNextLogger("files");

function registerStoredFile(file: StoredFile): void {
  fileIndex.set(file.id, file);
  fileIndex.set(file.urlToken, file);
  fileTokenIndex.set(file.id, file);
  fileTokenIndex.set(file.urlToken, file);
}

function resolveStoredFile(key: string): StoredFile | undefined {
  return fileIndex.get(key) ?? fileTokenIndex.get(key);
}

/** Clear the in-memory file index. Test-only: simulates a gateway restart. */
export function clearFileIndexForTest(): void {
  fileIndex.clear();
  fileTokenIndex.clear();
  externalFileSourceIndex.clear();
}

/**
 * The on-disk basename is a `<uuid>.<ext>` token, and the original filename lives only in
 * the process-local `fileIndex`. To keep the real name after a gateway restart (when the
 * index is empty) we persist it in a sidecar JSON file next to each stored attachment.
 */
interface AttachmentMetaSidecar {
  filename: string;
  mimeType: string;
}

const META_SIDECAR_SUFFIX = ".fnmeta";

function metaSidecarPath(urlToken: string): string {
  return path.join(getAttachmentsDir(), `${urlToken}${META_SIDECAR_SUFFIX}`);
}

function writeAttachmentMetaSidecar(urlToken: string, filename: string, mimeType: string): void {
  try {
    fs.writeFileSync(metaSidecarPath(urlToken), JSON.stringify({ filename, mimeType }));
  } catch (err) {
    logger.warn(`writeAttachmentMetaSidecar failed for "${urlToken}": ${String(err)}`);
  }
}

/**
 * Remember the original upload filename for an inbound media file.
 *
 * When a user sends an attachment, core's media-store copies it to
 * `~/.openclaw/media/inbound/<uuid>` — a bare uuid with no extension and no original
 * name — and the transcript records THAT path. So on history rebuild the original name
 * is unrecoverable. We stash it here (keyed by the inbound basename, reusing the sidecar
 * scheme but inside our own attachments dir) at send time, while we still know it.
 */
export function rememberInboundMediaName(
  inboundPath: string,
  filename: string,
  mimeType: string,
): void {
  const key = path.basename(inboundPath);
  const name = filename.trim();
  if (!key || !name) return;
  writeAttachmentMetaSidecar(key, name, mimeType);
}

function readAttachmentMetaSidecar(urlToken: string): AttachmentMetaSidecar | null {
  try {
    const raw = fs.readFileSync(metaSidecarPath(urlToken), "utf8");
    const parsed = JSON.parse(raw) as Partial<AttachmentMetaSidecar>;
    if (parsed && typeof parsed.filename === "string" && parsed.filename) {
      return {
        filename: parsed.filename,
        mimeType: typeof parsed.mimeType === "string" ? parsed.mimeType : "",
      };
    }
  } catch {
    // Missing or malformed sidecar (e.g. attachment stored before this fix) — caller
    // falls back to the on-disk basename.
  }
  return null;
}

/**
 * Read a file from `attachments/` by URL path token (disk basename).
 * Used when the in-memory index was cleared after a gateway restart.
 */
export function readAttachmentFileFromDisk(fileToken: string): {
  buffer: Buffer;
  mimeType: string;
  /** Original display/download filename (from sidecar; falls back to the on-disk basename). */
  filename: string;
  /** On-disk basename / urlToken — use this to build `/friday-next/files/{token}` URLs. */
  diskName: string;
} | null {
  const safe = path.basename(fileToken);
  if (!safe || safe === "." || safe === "..") return null;
  if (safe.endsWith(META_SIDECAR_SUFFIX)) return null;
  const dir = getAttachmentsDir();
  const full = path.join(dir, safe);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  try {
    const buffer = fs.readFileSync(full);
    const meta = readAttachmentMetaSidecar(safe);
    return {
      buffer,
      mimeType: meta?.mimeType || guessMimeType(safe),
      filename: meta?.filename || safe,
      diskName: safe,
    };
  } catch {
    return null;
  }
}

/**
 * Copy a local file into `attachments/` and register it (no full-buffer read for the copy path).
 */
/** Expand ~, file://, etc. for paths coming from the agent / message tool. */
export function normalizeAgentMediaPath(raw: string): string {
  const s = raw.trim();
  if (!s) return s;
  try {
    if (/^file:/i.test(s)) {
      return fileURLToPath(s);
    }
  } catch {
    // ignore malformed file URL
  }
  if (s.startsWith("~/") || s.startsWith("~\\")) {
    return path.join(os.homedir(), s.slice(2));
  }
  if (s === "~") {
    return os.homedir();
  }
  return s;
}

function copyLocalFileToAttachments(
  sourcePath: string,
  originalFilename?: string,
): StoredFile | null {
  const resolvedPath = normalizeAgentMediaPath(sourcePath);
  const diskBasename = path.basename(resolvedPath);
  // Prefer the caller-supplied original name (recovered from an inbound sidecar); fall
  // back to the on-disk basename (which for core inbound media is a bare uuid).
  const filename = originalFilename?.trim() || diskBasename;
  if (!filename) return null;
  try {
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) return null;
    const id = crypto.randomUUID();
    const ext = path.extname(filename) || path.extname(diskBasename);
    const urlToken = ext ? `${id}${ext}` : id;
    const storedPath = path.join(getAttachmentsDir(), urlToken);
    try {
      fs.copyFileSync(resolvedPath, storedPath);
    } catch (copyErr) {
      // macOS Desktop/iCloud files may fail copyFile with unknown errno (-11).
      // Fallback to read+write so attachment persistence still works.
      const raw = fs.readFileSync(resolvedPath);
      fs.writeFileSync(storedPath, raw);
      logger.warn(
        `copyLocalFileToAttachments copy fallback used for "${resolvedPath}": ${String(copyErr)}`,
      );
    }
    const stat = fs.statSync(storedPath);
    const mimeType = guessMimeType(filename);
    const file: StoredFile = {
      id,
      urlToken,
      filename,
      mimeType,
      size: stat.size,
      path: storedPath,
      createdAt: Date.now(),
    };
    registerStoredFile(file);
    writeAttachmentMetaSidecar(urlToken, filename, mimeType);
    return file;
  } catch (err) {
    logger.error(`copyLocalFileToAttachments failed for "${resolvedPath}": ${String(err)}`);
    return null;
  }
}

/**
 * Store a file buffer and return its ID and metadata.
 */
export function storeFile(buffer: Buffer, filename: string, mimeType: string): StoredFile {
  const id = crypto.randomUUID();
  const safeFilename = path.basename(filename) || "file";
  const ext = path.extname(safeFilename);
  const urlToken = ext ? `${id}${ext}` : id;
  const storedPath = path.join(getAttachmentsDir(), urlToken);

  try {
    fs.writeFileSync(storedPath, buffer);
  } catch (err) {
    throw new Error(`Failed to store file: ${String(err)}`, { cause: err });
  }

  const file: StoredFile = {
    id,
    urlToken,
    filename: safeFilename,
    mimeType,
    size: buffer.length,
    path: storedPath,
    createdAt: Date.now(),
  };

  registerStoredFile(file);
  writeAttachmentMetaSidecar(urlToken, safeFilename, mimeType);
  return file;
}

/**
 * Retrieve file metadata by ID or url token.
 */
export function getFile(id: string): StoredFile | undefined {
  return resolveStoredFile(id);
}

/**
 * Path segment for lookup: raw uuid / urlToken, or token extracted from `/friday-next/files/...`.
 */
export function fridayAttachmentLookupKey(ref: string): string {
  const s = ref.trim();
  if (!s) return s;
  if (s.startsWith("/friday-next/files/")) {
    return decodeURIComponent(s.slice("/friday-next/files/".length));
  }
  return s;
}

/**
 * Canonical gateway URL `/friday-next/files/{urlToken}` with extension when stored (for history, MediaUrls).
 */
export function fridayFilesPublicUrl(ref: string): string {
  const lookupKey = fridayAttachmentLookupKey(ref);
  if (!lookupKey) return ref.trim();

  const file = resolveStoredFile(lookupKey);
  if (file) {
    return `/friday-next/files/${encodeURIComponent(file.urlToken)}`;
  }

  const disk = readAttachmentFileFromDisk(lookupKey);
  if (disk) {
    return `/friday-next/files/${encodeURIComponent(disk.diskName)}`;
  }

  const trimmed = ref.trim();
  if (trimmed.startsWith("/friday-next/files/")) {
    return `/friday-next/files/${encodeURIComponent(lookupKey)}`;
  }
  return `/friday-next/files/${encodeURIComponent(lookupKey)}`;
}

export function getExternalFileSourceByUrlToken(token: string): string | undefined {
  return externalFileSourceIndex.get(token);
}

/**
 * Read a file as a Buffer with its MIME type (by id or urlToken).
 */
export function readFile(id: string): {
  buffer: Buffer | null;
  mimeType: string;
  filename?: string;
} {
  const file = resolveStoredFile(id);
  if (!file) return { buffer: null, mimeType: "application/octet-stream" };
  try {
    return { buffer: fs.readFileSync(file.path), mimeType: file.mimeType, filename: file.filename };
  } catch {
    return { buffer: null, mimeType: file.mimeType, filename: file.filename };
  }
}

/**
 * Copy a file from a local filesystem path into the Friday Next channel file store
 * and return its /friday-next/files/{token} URL. If the path is already a Friday Next channel
 * file URL (i.e. starts with "/friday-next/files/"), return it as-is.
 */
export function resolveMediaUrl(localPath: string): string {
  if (localPath.startsWith("/friday-next/files/")) {
    return localPath;
  }

  const stored = copyLocalFileToAttachments(localPath);
  if (!stored) {
    logger.error(`resolveMediaUrl: file not found or unreadable: ${localPath}`);
    return localPath;
  }
  logger.info(`resolveMediaUrl: copied "${stored.filename}" → ${stored.urlToken}`);
  return `/friday-next/files/${encodeURIComponent(stored.urlToken)}`;
}

export interface ResolvedAttachment {
  fileName: string;
  url: string;
}

/**
 * Resolve a local path into a Friday-served attachment descriptor.
 * Returns null when source file is missing or cannot be copied.
 */
export function resolveMediaAttachment(localPath: string): ResolvedAttachment | null {
  if (localPath.startsWith("/friday-next/files/")) {
    const token = decodeURIComponent(localPath.slice("/friday-next/files/".length));
    const file = resolveStoredFile(token);
    if (file) {
      return {
        fileName: file.filename,
        url: `/friday-next/files/${encodeURIComponent(file.urlToken)}`,
      };
    }
    const disk = readAttachmentFileFromDisk(token);
    if (disk) {
      return {
        fileName: disk.filename,
        url: `/friday-next/files/${encodeURIComponent(token)}`,
      };
    }
    const fallback = path.basename(token);
    return { fileName: fallback, url: localPath };
  }

  const basename = path.basename(localPath);
  if (!basename) return null;

  // Core inbound media is stored as a bare uuid (no name/extension). Recover the original
  // upload name we stashed at send time, keyed by that uuid basename.
  const remembered = readAttachmentMetaSidecar(basename)?.filename;
  const originalName = remembered || basename;

  const stored = copyLocalFileToAttachments(localPath, originalName);
  if (!stored) {
    // Best-effort fallback: still return a Friday URL so app can receive attachment event.
    // Download handler will try reading external source path lazily by token.
    const id = crypto.randomUUID();
    const ext = path.extname(originalName);
    const token = ext ? `${id}${ext}` : id;
    externalFileSourceIndex.set(token, normalizeAgentMediaPath(localPath));
    return {
      fileName: originalName,
      url: `/friday-next/files/${encodeURIComponent(token)}`,
    };
  }
  return {
    fileName: stored.filename,
    url: `/friday-next/files/${encodeURIComponent(stored.urlToken)}`,
  };
}

/**
 * Guess MIME type from filename extension.
 */
export function guessMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".heic": "image/heic",
    ".pdf": "application/pdf",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".zip": "application/zip",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".csv": "text/csv",
    ".json": "application/json",
  };
  return mimeTypes[ext] ?? "application/octet-stream";
}
