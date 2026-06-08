import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeBase64Media, downloadRemoteMedia, isHttpUrl } from "./media-fetch.js";

describe("isHttpUrl", () => {
  it("matches http/https links, rejects local paths", () => {
    expect(isHttpUrl("https://picsum.photos/600/400")).toBe(true);
    expect(isHttpUrl("http://example.com/a.png")).toBe(true);
    expect(isHttpUrl("  HTTPS://EXAMPLE.com/a.png ")).toBe(true);
    expect(isHttpUrl("/tmp/test.jpg")).toBe(false);
    expect(isHttpUrl("file:///tmp/test.jpg")).toBe(false);
    expect(isHttpUrl("shot.png")).toBe(false);
  });
});

describe("downloadRemoteMedia", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads bytes and prefers the response content-type", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes, { status: 200, headers: { "content-type": "image/png" } })),
    );

    const result = await downloadRemoteMedia("https://picsum.photos/600/400");
    expect(result).toBeTruthy();
    expect(result?.mimeType).toBe("image/png");
    expect(result?.buffer.length).toBe(bytes.length);
  });

  it("falls back to the URL extension when content-type is octet-stream", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(bytes, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          }),
      ),
    );

    const result = await downloadRemoteMedia("https://cdn.example.com/photo.jpg");
    expect(result?.mimeType).toBe("image/jpeg");
  });

  it("returns null on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    expect(await downloadRemoteMedia("https://example.com/missing.png")).toBeNull();
  });

  it("returns null when the content-length exceeds the cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-type": "image/png", "content-length": String(64 * 1024 * 1024) },
          }),
      ),
    );
    expect(await downloadRemoteMedia("https://example.com/huge.png")).toBeNull();
  });

  it("returns null on a network error instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    expect(await downloadRemoteMedia("https://example.com/x.png")).toBeNull();
  });
});

describe("decodeBase64Media", () => {
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

  it("decodes a bare base64 string with a mime hint", () => {
    const result = decodeBase64Media(jpegBytes.toString("base64"), "image/jpeg");
    expect(result?.mimeType).toBe("image/jpeg");
    expect(result?.buffer.equals(jpegBytes)).toBe(true);
  });

  it("decodes a data: URL and infers the mime from it", () => {
    const dataUrl = `data:image/png;base64,${jpegBytes.toString("base64")}`;
    const result = decodeBase64Media(dataUrl);
    expect(result?.mimeType).toBe("image/png");
    expect(result?.buffer.equals(jpegBytes)).toBe(true);
  });

  it("defaults to octet-stream when no mime is known", () => {
    expect(decodeBase64Media(jpegBytes.toString("base64"))?.mimeType).toBe(
      "application/octet-stream",
    );
  });

  it("rejects local paths and URLs (not base64)", () => {
    expect(decodeBase64Media("/tmp/test.jpg")).toBeNull();
    expect(decodeBase64Media("https://example.com/a.png")).toBeNull();
    expect(decodeBase64Media("")).toBeNull();
  });
});
