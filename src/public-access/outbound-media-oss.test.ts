import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sseEmitter } from "../sse/emitter.js";
import {
  deviceUsesPublicSurface,
  encryptOutboundBufferToFnoss,
  resolveOssOutboundConfig,
} from "./outbound-media-oss.js";
import { decodeRefURI } from "./oss-transfer.js";
import { decryptAttachment } from "./attachment-crypto.js";
import {
  createTempHistoryDir,
  removeTempHistoryDir,
  setMockRuntime,
} from "../test-support/mock-runtime.js";

/**
 * Per-device gating of the outbound OSS divert (E-wire ③): only devices whose SSE stream arrived
 * via the public relay (filter-proxy marker → `addConnection(viaPublic)`) divert to OSS. LAN and
 * offline devices keep the tunnel path — OSS traffic costs money and LAN direct is faster.
 */

class MockRes extends EventEmitter {
  write(): boolean {
    return true;
  }
  end(): void {
    // no-op
  }
}

function connect(deviceId: string, viaPublic: boolean) {
  return sseEmitter.addConnection(deviceId, new MockRes() as unknown as ServerResponse, viaPublic);
}

describe("deviceUsesPublicSurface", () => {
  let historyDir = "";

  beforeEach(() => {
    historyDir = createTempHistoryDir();
    setMockRuntime({ historyDir, publicAccessEnabled: true });
  });
  afterEach(() => {
    sseEmitter.resetForTest();
    removeTempHistoryDir(historyDir);
  });

  it("is false for offline devices, LAN connections, and closed connections; true only for a live public connection", () => {
    expect(deviceUsesPublicSurface("DEV-NONE")).toBe(false);
    expect(deviceUsesPublicSurface(undefined)).toBe(false);

    connect("DEV-LAN", false);
    expect(deviceUsesPublicSurface("DEV-LAN")).toBe(false);

    const pub = connect("DEV-PUB", true);
    expect(deviceUsesPublicSurface("DEV-PUB")).toBe(true);
    expect(deviceUsesPublicSurface("dev-pub")).toBe(true); // id normalization

    pub.close();
    expect(deviceUsesPublicSurface("DEV-PUB")).toBe(false);
  });
});

describe("encryptOutboundBufferToFnoss per-device gating", () => {
  let historyDir = "";

  beforeEach(() => {
    historyDir = createTempHistoryDir();
    setMockRuntime({
      historyDir,
      authToken: "gw-token",
      publicAccessEnabled: true,
      controlPlaneUrl: "http://cp.test",
    });
  });
  afterEach(() => {
    sseEmitter.resetForTest();
    removeTempHistoryDir(historyDir);
    vi.unstubAllGlobals();
  });

  it("returns null for a LAN-connected device without touching the network", async () => {
    connect("DEV-LAN", false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const out = await encryptOutboundBufferToFnoss(
      Buffer.from("bytes"),
      { name: "a.bin", mime: "application/octet-stream" },
      "DEV-LAN",
    );
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("diverts to a decryptable fnoss ref for a publicly-connected device", async () => {
    connect("DEV-PUB", true);
    const plaintext = Buffer.from("secret attachment bytes");
    let putBody: Buffer | null = null;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u === "http://cp.test/v1/oss/sign") {
        return new Response(
          JSON.stringify({
            objectKey: "att/test/obj",
            url: "http://oss.test/att/test/obj?sig=1",
            headers: { "content-type": "application/octet-stream" },
            expiresAt: 9999999999,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // OSS PUT — capture the ciphertext.
      putBody = Buffer.from(init?.body as Uint8Array);
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await encryptOutboundBufferToFnoss(
      plaintext,
      { name: "s.txt", mime: "text/plain" },
      "DEV-PUB",
    );
    expect(out).toMatch(/^fnoss:v1:/);
    const ref = decodeRefURI(out!);
    expect(ref).toBeTruthy();
    expect(ref!.mime).toBe("text/plain");
    expect(ref!.size).toBe(plaintext.length);
    // The uploaded ciphertext decrypts back to the plaintext with the key carried in the ref.
    expect(putBody).not.toBeNull();
    const roundtrip = decryptAttachment(putBody!, Buffer.from(ref!.key, "base64"));
    expect(Buffer.compare(roundtrip, plaintext)).toBe(0);
  });

  it("resolveOssOutboundConfig reflects the publicAccess config", () => {
    expect(resolveOssOutboundConfig()).toEqual({
      controlPlaneUrl: "http://cp.test",
      authToken: "gw-token",
    });
    setMockRuntime({ historyDir, publicAccessEnabled: false }); // operator hard stop
    expect(resolveOssOutboundConfig()).toBeNull();
  });
});
