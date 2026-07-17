/**
 * Plugin (gateway) side of the OSS attachment side-channel (Phase E5).
 *
 * Mirrors the app's `OSSAttachmentTransfer`: outbound agent media is encrypted (FNEA, per-object
 * random key), the control plane signs a scoped PUT URL, and the ciphertext is PUT directly to OSS.
 * The reference (objectId + content key + metadata) is handed back to travel over the gateway
 * tunnel — the relay/OSS only ever hold ciphertext. Inbound blobs (uploaded by the app) are signed
 * for GET, downloaded, and decrypted for the agent.
 *
 * Auth leg: the gateway presents `gatewayKey = sha256(authToken)` — the same key the allocator
 * registry is keyed by — to `/v1/oss/sign`. `null` returns signal "fall back to the tunnel path".
 */
import { createHash } from "node:crypto";
import { encryptAttachment, decryptAttachment, generateAttachmentKey } from "./attachment-crypto.js";

export type OSSTransferConfig = {
  /** Control-plane base, e.g. "https://friday.syengup.host" (client appends /v1). */
  controlPlaneUrl: string;
  /** The gateway's channel bearer token; hashed into the sign auth key. */
  authToken: string;
};

/** Attachment reference carried over the tunnel (contract §5.3). */
export type OSSAttachmentRef = {
  oss: 1;
  objectId: string;
  key: string; // base64 of the 32-byte content key
  mime: string;
  name: string;
  size: number; // plaintext bytes
  isImage: boolean;
};

type SignResult = { objectKey: string; url: string; headers: Record<string, string>; expiresAt: number };

function gatewayKey(authToken: string): string {
  return createHash("sha256").update(authToken || "").digest("hex");
}

async function sign(
  cfg: OSSTransferConfig,
  op: "put" | "get",
  objectId: string,
  size?: number,
  contentType?: string,
): Promise<SignResult | null> {
  try {
    const res = await fetch(`${cfg.controlPlaneUrl.replace(/\/$/, "")}/v1/oss/sign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, gatewayKey: gatewayKey(cfg.authToken), objectId, size, contentType }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null; // 503 not_configured / 429 quota / … → tunnel fallback
    return (await res.json()) as SignResult;
  } catch {
    return null;
  }
}

function randomObjectId(): string {
  return createHash("sha256").update(generateAttachmentKey()).digest("hex").slice(0, 32);
}

/** Encrypt + upload outbound media. Returns the tunnel reference, or null to fall back to tunnel. */
export async function uploadOutboundMedia(
  cfg: OSSTransferConfig,
  plaintext: Buffer,
  opts: { name: string; mime: string; isImage: boolean },
): Promise<OSSAttachmentRef | null> {
  const key = generateAttachmentKey();
  const objectId = randomObjectId();
  const cipher = encryptAttachment(plaintext, key);
  const signed = await sign(cfg, "put", objectId, cipher.length, "application/octet-stream");
  if (!signed) return null;
  try {
    const res = await fetch(signed.url, {
      method: "PUT",
      headers: signed.headers,
      // Node's fetch accepts a Uint8Array body at runtime; the DOM/undici BodyInit type union
      // rejects it (a known dual-fetch-typings friction), so cast the zero-copy view.
      body: new Uint8Array(cipher.buffer, cipher.byteOffset, cipher.byteLength) as unknown as BodyInit,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return null;
  } catch {
    return null;
  }
  return {
    oss: 1,
    objectId,
    key: key.toString("base64"),
    mime: opts.mime,
    name: opts.name,
    size: plaintext.length,
    isImage: opts.isImage,
  };
}

/** Download + decrypt an inbound blob referenced by the app. Returns plaintext, or null. */
export async function downloadInboundMedia(
  cfg: OSSTransferConfig,
  ref: OSSAttachmentRef,
): Promise<Buffer | null> {
  const key = Buffer.from(ref.key, "base64");
  if (key.length !== 32) return null;
  const signed = await sign(cfg, "get", ref.objectId);
  if (!signed) return null;
  try {
    const res = await fetch(signed.url, { method: "GET", signal: AbortSignal.timeout(120_000) });
    if (!res.ok) return null;
    const cipher = Buffer.from(await res.arrayBuffer());
    return decryptAttachment(cipher, key);
  } catch {
    return null;
  }
}

/** Type guard for an OSS reference arriving on the wire (app-uploaded inbound attachment). */
export function isOSSAttachmentRef(v: unknown): v is OSSAttachmentRef {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { oss?: unknown }).oss === 1 &&
    typeof (v as { objectId?: unknown }).objectId === "string" &&
    typeof (v as { key?: unknown }).key === "string"
  );
}

/** `fnoss:v1:<base64url(json)>` — carries the whole reference (incl. content key) inside the
 * existing string-typed media-url channel over the tunnel, so no event/payload schema changes.
 * Byte-compatible with the Swift `OSSAttachmentRef.fnossURI`. */
export const OSS_URI_SCHEME = "fnoss:v1:";

export function encodeRefURI(ref: OSSAttachmentRef): string {
  return OSS_URI_SCHEME + Buffer.from(JSON.stringify(ref), "utf8").toString("base64url");
}

export function decodeRefURI(uri: string): OSSAttachmentRef | null {
  if (typeof uri !== "string" || !uri.startsWith(OSS_URI_SCHEME)) return null;
  try {
    const json = Buffer.from(uri.slice(OSS_URI_SCHEME.length), "base64url").toString("utf8");
    const ref = JSON.parse(json) as unknown;
    return isOSSAttachmentRef(ref) ? ref : null;
  } catch {
    return null;
  }
}
