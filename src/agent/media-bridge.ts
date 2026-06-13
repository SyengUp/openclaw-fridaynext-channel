import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export async function saveInboundMediaBuffer(
  buffer: Buffer,
  mimeType: string,
  originalFilename?: string,
): Promise<{ id: string; path: string }> {
  try {
    const sdk = await import("openclaw/plugin-sdk/media-store");
    // Pass the original filename (5th arg) so core's media-store preserves the
    // name+extension instead of saving a bare uuid. Otherwise the agent receives
    // `[media attached: file://.../inbound/<uuid>]` with no file-format signal.
    const saved = await sdk.saveMediaBuffer(buffer, mimeType, "inbound", undefined, originalFilename);
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
