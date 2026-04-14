/**
 * Extract filesystem / Friday file URLs from message tool result or params (nested JSON).
 */

/** Bare path string when JSON.parse fails (e.g. not JSON); not http(s) URLs. */
function looksLikeLocalFilePath(v: string): boolean {
  const t = v.trim();
  if (t.length < 2 || /^https?:\/\//i.test(t)) return false;
  const abs =
    t.startsWith("/") ||
    t.startsWith("~/") ||
    t.startsWith("~\\") ||
    /^file:/i.test(t) ||
    /^[a-zA-Z]:[\\/]/.test(t);
  if (!abs) return false;
  const lastSeg = t.split(/[/\\]/).filter(Boolean).pop() ?? "";
  return lastSeg.includes(".");
}

export function collectMediaPathsFromToolResult(raw: unknown, acc?: Set<string>): Set<string> {
  const out = acc ?? new Set<string>();
  const add = (s: string) => {
    const t = s.trim();
    if (t.length > 0) out.add(t);
  };
  const visit = (v: unknown): void => {
    if (v == null) return;
    if (typeof v === "string") {
      try {
        visit(JSON.parse(v));
      } catch {
        if (looksLikeLocalFilePath(v)) add(v);
      }
      return;
    }
    if (typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    const o = v as Record<string, unknown>;
    const mu = o.mediaUrls;
    if (Array.isArray(mu)) for (const x of mu) if (typeof x === "string") add(x);
    const m = o.mediaUrl;
    if (typeof m === "string") add(m);
    const audioPath = o.audioPath;
    if (typeof audioPath === "string") add(audioPath);
    const media = o.media;
    if (typeof media === "string") add(media);
    else if (media && typeof media === "object" && !Array.isArray(media)) visit(media);
    const filePath = o.filePath;
    if (typeof filePath === "string") add(filePath);
    for (const k of ["details", "result", "content", "text", "body", "message", "arguments", "args"]) {
      if (o[k] !== undefined) visit(o[k]);
    }
    for (const val of Object.values(o)) {
      if (typeof val !== "string") continue;
      const s = val.trimStart();
      if (s.startsWith("{") || s.startsWith("[")) visit(val);
    }
  };
  visit(raw);
  return out;
}

/**
 * Scan the same tool `text` string that is sent on SSE (often JSON.stringify(result)).
 * Inner nested JSON uses escaped quotes (\"), so keys like "mediaUrl" may not match
 * naive JSON walks on the outer value. Unescaped absolute paths still appear verbatim
 * (e.g. /Users/.../file.md) and are extracted here.
 */
export function extractLocalPathsFromToolTextBlob(s: string): Set<string> {
  const out = new Set<string>();
  const add = (raw: string) => {
    const t = raw.trim();
    if (t.length > 0 && looksLikeLocalFilePath(t)) out.add(t);
  };
  if (!s || s.length < 8) return out;

  /**
   * After JSON.stringify(toolResult), nested JSON appears as key\"\":\"value\" in the outer string,
   * e.g. mediaUrl\":\"/Users/me/file.md\" — not \"mediaUrl\".
   */
  for (const m of s.matchAll(/mediaUrl\\":\\"([^"\\]+)\\"/gi)) {
    add(m[1] ?? "");
  }
  for (const m of s.matchAll(/media\\":\\"([^"\\]+)\\"/gi)) {
    add(m[1] ?? "");
  }
  for (const m of s.matchAll(/filePath\\":\\"([^"\\]+)\\"/gi)) {
    add(m[1] ?? "");
  }

  // "mediaUrls":["/a","/b"] → in outer stringify: mediaUrls\":[\"/a\",\"/b\"]
  for (const m of s.matchAll(/mediaUrls\\":\[((?:\\"[^"\\]+\\",?)+)\]/gi)) {
    const inner = m[1] ?? "";
    for (const q of inner.matchAll(/\\"([^"\\]+)\\"/g)) {
      add(q[1] ?? "");
    }
  }

  // Unescaped JSON fragments (raw object / pretty-print)
  for (const m of s.matchAll(/"mediaUrl"\s*:\s*"([^"\\]+)"/gi)) {
    add(m[1] ?? "");
  }
  for (const m of s.matchAll(/"mediaUrls"\s*:\s*\[([\s\S]*?)\]/gi)) {
    const inner = m[1] ?? "";
    for (const q of inner.matchAll(/"([^"\\]*)"/g)) {
      add(q[1] ?? "");
    }
  }

  // Verbatim /Users/.../file.ext (stop before quote or backslash — avoids eating JSON commas)
  for (const m of s.matchAll(/(\/Users\/[^"\\]+\.[A-Za-z0-9]{1,24})/g)) {
    add(m[1]!);
  }
  for (const m of s.matchAll(/(\/private\/var\/[^"\\]+\.[A-Za-z0-9]{1,24})/g)) {
    add(m[1]!);
  }
  for (const m of s.matchAll(/(\/tmp\/[^"\\]+\.[A-Za-z0-9]{1,24})/g)) {
    add(m[1]!);
  }
  for (const m of s.matchAll(/(\/home\/[^"\\]+\.[A-Za-z0-9]{1,24})/g)) {
    add(m[1]!);
  }

  for (const m of s.matchAll(/([A-Za-z]:\\[^"\\]+\.[A-Za-z0-9]{1,24})/g)) {
    add(m[1]!);
  }

  return out;
}
