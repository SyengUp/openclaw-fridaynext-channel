/**
 * Open Graph metadata extraction via regex — no HTML parser dependency.
 *
 * Good enough for the link-preview card use case: og:* meta tags are flat, attribute-ordered
 * variants are handled generically, and pages where this fails simply degrade to "no card".
 */

const MAX_PARSE_BYTES = 512 * 1024;

export interface OpenGraphResult {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  /** Favicon URL parsed from `<link rel="...icon...">`, resolved absolute. */
  iconUrl: string | null;
}

const META_TAG_RE = /<meta\b[^>]*>/gi;
const TITLE_TAG_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const LINK_TAG_RE = /<link\b[^>]*>/gi;

/** Extract one attribute value from a tag, tolerating single/double/no quotes and any order. */
function attributeValue(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = tag.match(re);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? "";
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
};

export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function cleanText(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const text = decodeHtmlEntities(raw).replace(/\s+/g, " ").trim();
  return text || null;
}

/** Resolve og:image (possibly relative) against the final page URL; only http(s) survives. */
function resolveImageUrl(raw: string | null | undefined, baseUrl: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim(), baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function parseOpenGraph(html: string, baseUrl: string): OpenGraphResult {
  const slice = html.length > MAX_PARSE_BYTES ? html.slice(0, MAX_PARSE_BYTES) : html;

  // First occurrence wins per key (matches browser/crawler behavior).
  const og: Record<string, string> = {};
  const tw: Record<string, string> = {};
  let metaDescription: string | null = null;
  for (const match of slice.matchAll(META_TAG_RE)) {
    const tag = match[0];
    const key = (attributeValue(tag, "property") ?? attributeValue(tag, "name"))?.trim().toLowerCase();
    if (!key) continue;
    const content = attributeValue(tag, "content");
    if (content == null || !content.trim()) continue;
    if (key.startsWith("og:")) {
      const ogKey = key.slice(3);
      if (!(ogKey in og)) og[ogKey] = content;
    } else if (key.startsWith("twitter:")) {
      const twKey = key.slice(8);
      if (!(twKey in tw)) tw[twKey] = content;
    } else if (key === "description" && metaDescription == null) {
      metaDescription = content;
    }
  }

  const ld = parseJsonLd(slice);
  const pageTitle = slice.match(TITLE_TAG_RE)?.[1] ?? null;

  // Title chain: standard tags first, then server-rendered body title (h1 / article-title class)
  // BEFORE the generic <title> — many SPA/news shells put a useless <title> ("搜索资讯页") in the
  // head while the real headline lives in the body.
  const title =
    cleanText(og["title"]) ??
    cleanText(tw["title"]) ??
    cleanText(ld.title) ??
    cleanText(parseBodyTitle(slice)) ??
    cleanText(pageTitle);

  const description =
    cleanText(og["description"]) ??
    cleanText(tw["description"]) ??
    cleanText(ld.description) ??
    cleanText(metaDescription);

  const imageUrl =
    resolveImageUrl(og["image"] ?? null, baseUrl) ??
    resolveImageUrl(tw["image"] ?? null, baseUrl) ??
    resolveImageUrl(ld.image, baseUrl) ??
    resolveImageUrl(parseBodyCoverImage(slice), baseUrl);

  return {
    title,
    description,
    imageUrl,
    siteName: cleanText(og["site_name"] ?? tw["site"] ?? null),
    iconUrl: parseFaviconUrl(slice, baseUrl),
  };
}

const JSON_LD_RE = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Extract title/description/image from JSON-LD blocks (schema.org Article/NewsArticle/etc.). */
function parseJsonLd(html: string): { title: string | null; description: string | null; image: string | null } {
  for (const match of html.matchAll(JSON_LD_RE)) {
    let data: unknown;
    try {
      data = JSON.parse(match[1].trim());
    } catch {
      continue;
    }
    // JSON-LD may be a single object, an array, or a @graph container.
    const nodes: unknown[] = Array.isArray(data)
      ? data
      : isRecord(data) && Array.isArray(data["@graph"])
        ? (data["@graph"] as unknown[])
        : [data];
    for (const node of nodes) {
      if (!isRecord(node)) continue;
      const title = asString(node.headline) ?? asString(node.name);
      const description = asString(node.description);
      const image = firstImage(node.image) ?? asString(node.thumbnailUrl);
      if (title || description || image) {
        return { title: title ?? null, description: description ?? null, image: image ?? null };
      }
    }
  }
  return { title: null, description: null, image: null };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/** JSON-LD `image` is a string, an array, or an ImageObject `{ url }`. */
function firstImage(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    for (const item of v) {
      const found = firstImage(item);
      if (found) return found;
    }
    return null;
  }
  if (isRecord(v)) return asString(v.url);
  return null;
}

// Common server-rendered article-title class names (whitelist keeps false positives down vs. any
// class containing "title", e.g. a sidebar "related-titles" block).
const BODY_TITLE_CLASS_RE =
  /class\s*=\s*["'][^"']*\b(?:article-title|post-title|entry-title|news-title|content-title|headline|title-text)\b[^"']*["'][^>]*>\s*([^<]{4,200}?)\s*</i;
const H1_RE = /<h1\b[^>]*>\s*([\s\S]{4,200}?)\s*<\/h1>/i;

/** Server-rendered headline fallback: first <h1>, else an element with a known article-title class. */
function parseBodyTitle(html: string): string | null {
  const h1 = html.match(H1_RE)?.[1];
  if (h1) {
    const text = stripTags(h1).trim();
    if (text.length >= 4) return text;
  }
  return html.match(BODY_TITLE_CLASS_RE)?.[1] ?? null;
}

// Cover image embedded in inline JSON (e.g. QQ's `"imgUrl":"http:\/\/...cover..."`). The URL may be
// extensionless; the re-host step's magic-byte sniff is the safety net against non-image matches.
const JSON_COVER_RE =
  /"(?:imgUrl|imageUrl|coverUrl|coverImage|cover|ogImage|thumbnail|picUrl)"\s*:\s*"(https?:(?:\\?\/){2}[^"]+?)"/i;

/** Cover image from inline JSON when no og/twitter/json-ld image is present. */
function parseBodyCoverImage(html: string): string | null {
  const raw = html.match(JSON_COVER_RE)?.[1];
  if (!raw) return null;
  return raw.replace(/\\\//g, "/"); // unescape JSON `\/`
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

/**
 * Pick the best `<link rel="...icon...">` href. Prefers a high-res `apple-touch-icon`, then a
 * regular `icon` / `shortcut icon`. Skips `mask-icon` (monochrome SVG). Returns absolute http(s).
 */
export function parseFaviconUrl(html: string, baseUrl: string): string | null {
  let appleTouch: string | null = null;
  let regular: string | null = null;
  for (const match of html.matchAll(LINK_TAG_RE)) {
    const tag = match[0];
    const rel = attributeValue(tag, "rel")?.trim().toLowerCase();
    if (!rel || !rel.includes("icon") || rel.includes("mask-icon")) continue;
    const href = attributeValue(tag, "href");
    if (!href) continue;
    const resolved = resolveImageUrl(href, baseUrl);
    if (!resolved) continue;
    if (rel.includes("apple-touch-icon")) {
      appleTouch ??= resolved;
    } else {
      regular ??= resolved;
    }
  }
  return appleTouch ?? regular;
}
