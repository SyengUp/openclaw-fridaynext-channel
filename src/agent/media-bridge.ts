import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/**
 * openclaw's own per-kind byte cap for a mime type (image 6MB / audio·video 16MB /
 * document 100MB). Unknown mimes fall back to the most permissive ("document") cap.
 * Returns undefined if the media runtime isn't importable (tests / stripped runtime),
 * letting `saveMediaBuffer` apply its built-in default.
 */
export async function resolveMediaMaxBytes(mimeType: string): Promise<number | undefined> {
  try {
    const { maxBytesForKind, mediaKindFromMime } = await import("openclaw/plugin-sdk/media-runtime");
    return maxBytesForKind(mediaKindFromMime(mimeType) ?? "document");
  } catch {
    return undefined;
  }
}

export async function saveInboundMediaBuffer(
  buffer: Buffer,
  mimeType: string,
  originalFilename?: string,
): Promise<{ id: string; path: string }> {
  try {
    const sdk = await import("openclaw/plugin-sdk/media-store");
    // Accept whatever openclaw itself supports for this media kind instead of
    // saveMediaBuffer's conservative 5MB default.
    const maxBytes = await resolveMediaMaxBytes(mimeType);
    // Pass the original filename (5th arg) so core's media-store preserves the
    // name+extension instead of saving a bare uuid. Otherwise the agent receives
    // `[media attached: file://.../inbound/<uuid>]` with no file-format signal.
    const saved = await sdk.saveMediaBuffer(buffer, mimeType, "inbound", maxBytes, originalFilename);
    if (saved?.id && saved?.path) return { id: saved.id, path: saved.path };
  } catch {
    // fallback for tests or stripped runtime
  }
  const id = crypto.randomUUID();
  const dir = path.join(os.tmpdir(), "friday-next-media");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, id);
  fs.writeFileSync(p, buffer);
  return { id, path: p };
}
