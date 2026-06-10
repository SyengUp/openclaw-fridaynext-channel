/**
 * Link-preview orchestration: fetch page → parse Open Graph → re-host the cover image through
 * the gateway's stored files → cache.
 *
 * The cover image is downloaded server-side and served from /friday-next/files/ so the app only
 * ever talks to the trusted gateway host (same rationale as `downloadRemoteMedia` for outbound
 * media). Failures degrade to "no card" on the app side, so every error path returns a typed
 * error instead of throwing.
 */

import { createFridayNextLogger } from "../logging.js";
import { storeFile } from "../http/handlers/files.js";
import { parseOpenGraph } from "./og-parse.js";
import { BlockedUrlError, fetchPublicUrl, parseHttpUrl } from "./ssrf-guard.js";

const HTML_MAX_BYTES = 2 * 1024 * 1024;
const HTML_TIMEOUT_MS = 10_000;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 10_000;

const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;

const logger = createFridayNextLogger("link-preview");

export interface LinkPreviewPayload {
  url: string;
  finalUrl: string;
  siteName: string | null;
  title: string;
  description: string | null;
  /** Gateway-relative cover URL ("/friday-next/files/{token}") or null. */
  imageUrl: string | null;
  /** Gateway-relative favicon URL ("/friday-next/files/{token}") or null. */
  iconUrl: string | null;
  fetchedAt: number;
}

export type LinkPreviewError = "invalid_url" | "blocked_url" | "fetch_failed" | "no_metadata";

export type LinkPreviewResult =
  | { ok: true; preview: LinkPreviewPayload }
  | { ok: false; error: LinkPreviewError };

interface CacheEntry {
  result: LinkPreviewResult;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<LinkPreviewResult>>();

export function resetLinkPreviewCacheForTest(): void {
  cache.clear();
  inFlight.clear();
}

export async function getLinkPreview(rawUrl: string): Promise<LinkPreviewResult> {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) return { ok: false, error: "invalid_url" };
  const key = parsed.toString();

  const cached = cache.get(key);
  if (cached) {
    const ttl = cached.result.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
    if (Date.now() - cached.cachedAt < ttl) return cached.result;
    cache.delete(key);
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = buildPreview(key)
    .then((result) => {
      writeCache(key, result);
      return result;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, task);
  return task;
}

function writeCache(key: string, result: LinkPreviewResult): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, entry] of cache) {
      if (entry.cachedAt < oldestAt) {
        oldestAt = entry.cachedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, { result, cachedAt: Date.now() });
}

async function buildPreview(pageUrl: string): Promise<LinkPreviewResult> {
  let page;
  try {
    page = await fetchPublicUrl(pageUrl, {
      maxBytes: HTML_MAX_BYTES,
      timeoutMs: HTML_TIMEOUT_MS,
      accept: "text/html,application/xhtml+xml",
      requireContentTypePrefixes: ["text/html", "application/xhtml+xml"],
    });
  } catch (err) {
    if (err instanceof BlockedUrlError) {
      logger.warn(`link-preview blocked: ${pageUrl} (${err.reason})`);
      return { ok: false, error: "blocked_url" };
    }
    page = null; // network/timeout — fall through to a favicon-only minimal card
  }

  const finalUrl = page?.finalUrl ?? pageUrl;
  const og = page ? parseOpenGraph(page.body.toString("utf8"), finalUrl) : null;
  const hostname = (() => {
    try {
      return new URL(finalUrl).hostname;
    } catch {
      return null;
    }
  })();

  // Favicon: parsed <link rel icon> first, then the conventional /favicon.ico (which is reachable
  // even for pages that block bots, e.g. zhihu → redirects to its CDN icon).
  const iconUrl = await resolveFavicon(og?.iconUrl ?? null, finalUrl);

  // A failed page fetch only yields a (minimal) card when the favicon resolved — that proves the
  // domain is real/reachable (e.g. bot-blocked zhihu). A dead domain (favicon also fails) collapses.
  const reachable = page !== null || iconUrl !== null;
  const title = og?.title ?? hostname;
  if (!reachable || !title) {
    return { ok: false, error: page ? "no_metadata" : "fetch_failed" };
  }

  const imageUrl = og?.imageUrl ? await rehostCoverImage(og.imageUrl) : null;

  return {
    ok: true,
    preview: {
      url: pageUrl,
      finalUrl,
      siteName: og?.siteName ?? hostname,
      title: title ?? hostname ?? pageUrl,
      description: og?.description ?? null,
      imageUrl,
      iconUrl,
      fetchedAt: Date.now(),
    },
  };
}

/** Re-host a favicon: try the parsed `<link rel icon>`, then `<origin>/favicon.ico`. */
async function resolveFavicon(parsedIconUrl: string | null, finalUrl: string): Promise<string | null> {
  const candidates: string[] = [];
  if (parsedIconUrl) candidates.push(parsedIconUrl);
  try {
    candidates.push(new URL("/favicon.ico", finalUrl).toString());
  } catch {
    // finalUrl unparseable — skip the conventional fallback
  }
  for (const candidate of candidates) {
    const rehosted = await rehostIconImage(candidate);
    if (rehosted) return rehosted;
  }
  return null;
}

/** Download a favicon (full SSRF checks) and re-publish via stored files. Null on any failure. */
async function rehostIconImage(iconUrl: string): Promise<string | null> {
  let image;
  try {
    image = await fetchPublicUrl(iconUrl, {
      maxBytes: 1024 * 1024,
      timeoutMs: IMAGE_TIMEOUT_MS,
      accept: "image/*",
      requireContentTypePrefixes: ["image/"],
    });
  } catch {
    return null;
  }
  if (!image) return null;
  const sniffed = sniffImageType(image.body);
  if (!sniffed) return null;
  try {
    const stored = storeFile(image.body, `link-preview-icon.${sniffed.ext}`, sniffed.mime);
    return `/friday-next/files/${encodeURIComponent(stored.urlToken)}`;
  } catch {
    return null;
  }
}

/** Download og:image (full SSRF checks) and re-publish via stored files. Null on any failure. */
async function rehostCoverImage(imageUrl: string): Promise<string | null> {
  let image;
  try {
    image = await fetchPublicUrl(imageUrl, {
      maxBytes: IMAGE_MAX_BYTES,
      timeoutMs: IMAGE_TIMEOUT_MS,
      accept: "image/*",
      requireContentTypePrefixes: ["image/"],
    });
  } catch {
    return null; // blocked og:image just means no cover
  }
  if (!image) return null;

  const sniffed = sniffImageType(image.body);
  if (!sniffed) return null;

  try {
    const stored = storeFile(image.body, `link-preview-cover.${sniffed.ext}`, sniffed.mime);
    return `/friday-next/files/${encodeURIComponent(stored.urlToken)}`;
  } catch (err) {
    logger.warn(`link-preview cover store failed for ${imageUrl}: ${String(err)}`);
    return null;
  }
}

/** Magic-byte sniff — second line of defense after the Content-Type check. */
function sniffImageType(buffer: Buffer): { ext: string; mime: string } | null {
  if (buffer.length < 12) return null;
  // ICO: 00 00 01 00 (favicons are commonly .ico; iOS ImageIO decodes them).
  if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) {
    return { ext: "ico", mime: "image/x-icon" };
  }
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { ext: "png", mime: "image/png" };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  if (buffer.subarray(0, 4).toString("latin1") === "GIF8") {
    return { ext: "gif", mime: "image/gif" };
  }
  if (
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  return null;
}
