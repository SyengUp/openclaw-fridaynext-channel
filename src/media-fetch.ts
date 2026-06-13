import { guessMimeType } from "./http/handlers/files.js";

/**
 * Remote (http/https) media download for the `message` tool and outbound sendMedia.
 *
 * The agent often sends attachments as a direct link (`url: "https://.../foo.jpg"`) rather than a
 * local file path. The gateway can reach that link even when the user's device can't (ATS, foreign
 * TLS, intranet / geo differences), so we download it server-side and re-publish it through the
 * gateway's `/friday-next/files/` route — identical to the local-file path. This keeps the app's
 * download story uniform (always talks to the trusted gateway host with a bearer token).
 */

// Aligns with openclaw's own remote-media ceiling (DEFAULT_FETCH_MEDIA_MAX_BYTES =
// MAX_DOCUMENT_BYTES = 100MB). The real per-kind limit is enforced downstream by
// saveMediaBuffer (via resolveMediaMaxBytes); this is just the download ceiling.
const MAX_REMOTE_MEDIA_BYTES = 100 * 1024 * 1024; // 100MB
const REMOTE_MEDIA_TIMEOUT_MS = 20_000;

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

const DATA_URL_PREFIX_RE = /^data:([^;,]+)?(;base64)?,/i;

/**
 * Decode an inline base64 attachment (the `message` tool's `buffer` param). Accepts both a bare
 * base64 string and a `data:<mime>;base64,...` data URL.
 *
 * The charset guard rejects local paths / http URLs (which contain `:`/`.`), so callers can pass a
 * possibly-misused value safely — those fall through to the path/url resolver instead of being
 * decoded into garbage bytes. Like remote downloads, the mime is only a hint; `saveMediaBuffer`
 * re-detects the real type from magic bytes.
 */
export function decodeBase64Media(
  raw: string,
  mimeHint?: string,
): { buffer: Buffer; mimeType: string } | null {
  let body = raw.trim();
  let dataUrlMime = "";
  const match = body.match(DATA_URL_PREFIX_RE);
  if (match) {
    dataUrlMime = (match[1] ?? "").trim().toLowerCase();
    body = body.slice(match[0].length);
  }
  body = body.replace(/\s+/g, "");
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;

  let buffer: Buffer;
  try {
    buffer = Buffer.from(body, "base64");
  } catch {
    return null;
  }
  if (!buffer.length) return null;

  const mimeType =
    mimeHint?.trim().toLowerCase() || dataUrlMime || "application/octet-stream";
  return { buffer, mimeType };
}

/**
 * Download an http/https URL into a buffer. Returns null on any failure (non-2xx, oversize, timeout,
 * network error) so callers degrade to text-only rather than throwing.
 *
 * The mime type prefers the response `Content-Type`, falling back to the URL extension. It is only a
 * hint — `saveMediaBuffer` re-detects the real type from the buffer's magic bytes, so links without
 * an extension (e.g. `picsum.photos/600/400`) still land with the correct file type.
 */
export async function downloadRemoteMedia(
  url: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_MEDIA_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!res.ok) return null;

    const declaredLength = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_MEDIA_BYTES) {
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_REMOTE_MEDIA_BYTES) return null;

    const headerMime = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const extMime = guessMimeType(url);
    const mimeType =
      headerMime && headerMime !== "application/octet-stream"
        ? headerMime
        : extMime !== "application/octet-stream"
          ? extMime
          : headerMime || "application/octet-stream";

    return { buffer, mimeType };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
