/**
 * GET /friday-next/link-preview?url=<percent-encoded http(s) URL>
 *
 * Returns Open Graph metadata for a page link so the app can render a preview card without
 * ever contacting the third-party site itself. Cover images are re-hosted under
 * /friday-next/files/ by the preview service.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getLinkPreview, type LinkPreviewError } from "../../link-preview/preview-service.js";
import { extractBearerToken } from "../middleware/auth.js";

const ERROR_STATUS: Record<LinkPreviewError, number> = {
  invalid_url: 400,
  blocked_url: 403,
  no_metadata: 422,
  fetch_failed: 502,
};

export async function handleLinkPreview(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return true;
  }
  if (!extractBearerToken(req)) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
    return true;
  }

  const url = new URL(req.url ?? "/", "http://localhost").searchParams.get("url")?.trim();
  if (!url) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "invalid_url" }));
    return true;
  }

  const result = await getLinkPreview(url);
  res.statusCode = result.ok ? 200 : ERROR_STATUS[result.error];
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(result));
  return true;
}
