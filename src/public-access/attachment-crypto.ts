/**
 * FNEA — FridayNext Encrypted Attachment envelope (Phase E).
 *
 * Client-side content encryption for the OSS attachment side-channel. The relay/OSS
 * only ever store ciphertext; the per-object AES-256 key travels with the attachment
 * reference over the already-secure gateway tunnel (TLS-pinned + attested), so the
 * pairing parties (app ⇄ gateway) can decrypt and no one else can — matching the PRD
 * privacy boundary ("OSS 看不到明文，密钥在配对双方").
 *
 * Envelope (interoperable with the Swift `AttachmentCrypto`):
 *   header: "FNEA"(4) ‖ version(1)=1 ‖ chunkSize(uint32 BE)
 *   frames: [ nonce(12) ‖ ctLen(uint32 BE) ‖ ciphertext(ctLen) ‖ tag(16) ] …
 *   per-frame AAD (not stored, reconstructed on decrypt):
 *     frameIndex(uint64 BE) ‖ finalFlag(1)   — binds frame order + marks the last
 *     frame, so dropping/reordering/truncating frames fails authentication.
 *
 * Chunked (default 64 KiB plaintext frames) so encryption/decryption can stream and
 * never needs the whole file in memory, and so a fully-downloaded ciphertext decrypts
 * without the byte-range resume machinery ever seeing plaintext offsets.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const MAGIC = Buffer.from("FNEA", "ascii");
const VERSION = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;
export const DEFAULT_CHUNK = 64 * 1024;

/** Fresh per-object content key (AES-256). */
export function generateAttachmentKey(): Buffer {
  return randomBytes(32);
}

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function frameAAD(index: number, isFinal: boolean): Buffer {
  const b = Buffer.alloc(9);
  b.writeBigUInt64BE(BigInt(index), 0);
  b[8] = isFinal ? 1 : 0;
  return b;
}

/** Encrypt a whole plaintext buffer into an FNEA envelope. */
export function encryptAttachment(plaintext: Buffer, key: Buffer, chunkSize = DEFAULT_CHUNK): Buffer {
  if (key.length !== 32) throw new Error("attachment key must be 32 bytes");
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), u32be(chunkSize)]);
  const out: Buffer[] = [header];
  const total = plaintext.length;
  // At least one frame even for empty input, so an empty file round-trips.
  const frameCount = Math.max(1, Math.ceil(total / chunkSize));
  for (let i = 0; i < frameCount; i++) {
    const start = i * chunkSize;
    const chunk = plaintext.subarray(start, Math.min(start + chunkSize, total));
    const isFinal = i === frameCount - 1;
    const nonce = randomBytes(NONCE_LEN);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(frameAAD(i, isFinal));
    const ct = Buffer.concat([cipher.update(chunk), cipher.final()]);
    const tag = cipher.getAuthTag();
    out.push(nonce, u32be(ct.length), ct, tag);
  }
  return Buffer.concat(out);
}

/** Decrypt an FNEA envelope back to plaintext. Throws on any authentication failure
 * (tamper / truncation / reorder / wrong key). */
export function decryptAttachment(envelope: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error("attachment key must be 32 bytes");
  if (envelope.length < 9 || !envelope.subarray(0, 4).equals(MAGIC)) throw new Error("not an FNEA envelope");
  if (envelope[4] !== VERSION) throw new Error(`unsupported FNEA version ${envelope[4]}`);
  let off = 9; // skip header (chunkSize is advisory on decrypt)
  const chunks: Buffer[] = [];
  let index = 0;
  while (off < envelope.length) {
    if (off + NONCE_LEN + 4 > envelope.length) throw new Error("truncated frame header");
    const nonce = envelope.subarray(off, off + NONCE_LEN);
    off += NONCE_LEN;
    const ctLen = envelope.readUInt32BE(off);
    off += 4;
    if (off + ctLen + TAG_LEN > envelope.length) throw new Error("truncated frame body");
    const ct = envelope.subarray(off, off + ctLen);
    off += ctLen;
    const tag = envelope.subarray(off, off + TAG_LEN);
    off += TAG_LEN;
    const isFinal = off >= envelope.length; // last frame = nothing follows
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(frameAAD(index, isFinal));
    decipher.setAuthTag(tag);
    chunks.push(Buffer.concat([decipher.update(ct), decipher.final()]));
    index++;
  }
  return Buffer.concat(chunks);
}
