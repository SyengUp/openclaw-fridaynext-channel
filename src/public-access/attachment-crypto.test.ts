import { describe, it, expect } from "vitest";
import {
  encryptAttachment,
  decryptAttachment,
  generateAttachmentKey,
  DEFAULT_CHUNK,
} from "./attachment-crypto.js";

describe("FNEA attachment crypto", () => {
  it("round-trips small plaintext", () => {
    const key = generateAttachmentKey();
    const pt = Buffer.from("hello 星期五 attachment 🎈", "utf8");
    const env = encryptAttachment(pt, key);
    expect(env.subarray(0, 4).toString("ascii")).toBe("FNEA");
    expect(decryptAttachment(env, key).equals(pt)).toBe(true);
  });

  it("round-trips empty plaintext", () => {
    const key = generateAttachmentKey();
    const env = encryptAttachment(Buffer.alloc(0), key);
    expect(decryptAttachment(env, key).length).toBe(0);
  });

  it("round-trips across chunk boundaries (multi-frame)", () => {
    const key = generateAttachmentKey();
    for (const size of [DEFAULT_CHUNK - 1, DEFAULT_CHUNK, DEFAULT_CHUNK + 1, DEFAULT_CHUNK * 3 + 7]) {
      const pt = Buffer.alloc(size);
      for (let i = 0; i < size; i++) pt[i] = (i * 31 + 7) & 0xff;
      const env = decryptAttachment(encryptAttachment(pt, key), key);
      expect(env.equals(pt), `size=${size}`).toBe(true);
    }
  });

  it("uses a small chunk size to force many frames", () => {
    const key = generateAttachmentKey();
    const pt = Buffer.from("0123456789abcdef", "utf8");
    const env = encryptAttachment(pt, key, 4);
    expect(decryptAttachment(env, key).equals(pt)).toBe(true);
  });

  it("rejects a wrong key", () => {
    const env = encryptAttachment(Buffer.from("secret"), generateAttachmentKey());
    expect(() => decryptAttachment(env, generateAttachmentKey())).toThrow();
  });

  it("rejects a tampered ciphertext byte", () => {
    const key = generateAttachmentKey();
    const env = encryptAttachment(Buffer.from("secret payload"), key);
    env[env.length - 20] ^= 0x01; // flip a byte inside the ciphertext region
    expect(() => decryptAttachment(env, key)).toThrow();
  });

  it("rejects truncation (dropping the final frame)", () => {
    const key = generateAttachmentKey();
    const pt = Buffer.alloc(4 * 3); // 3 frames at chunk=4
    const env = encryptAttachment(pt, key, 4);
    // Strip the last frame: nonce(12)+ctLen(4)+ct(4)+tag(16) = 36 bytes.
    const truncated = env.subarray(0, env.length - 36);
    // The new "last" frame was encoded with final=0 → decrypt tries final=1 → auth fails.
    expect(() => decryptAttachment(truncated, key)).toThrow();
  });

  it("rejects a non-FNEA buffer", () => {
    expect(() => decryptAttachment(Buffer.from("not an envelope"), generateAttachmentKey())).toThrow(
      /not an FNEA/,
    );
  });

  it("INTEROP swift→node: decrypts an envelope produced by the Swift AttachmentCrypto", () => {
    // key = 32 bytes 0x00…0x1f ; plaintext = "FridayNext" ; chunk=4. Emitted by the Swift
    // test `testEmitSwiftVectorForNode`. Proves the wire format is byte-compatible both ways.
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    const swiftHex =
      "464e45410100000004f1e94639e7a17e92eb3edaa700000004af83c2f5f5a8ccfcd5fd45c0cf0399f5da3891c3c71f42c3f1f26ffd4f8b0f5c000000047740d3d11bd52f60c8a0992432f6aa12e21fe2617ba9df103bb182a2ab6a43e000000002406780dbe4d0f9a2921d46abea4812f73ca3";
    const env = Buffer.from(swiftHex, "hex");
    expect(decryptAttachment(env, key).toString("utf8")).toBe("FridayNext");
  });
});
