import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

vi.mock("node:dns/promises", () => ({
  default: { lookup: vi.fn() },
}));

import dns from "node:dns/promises";
import { handleLinkPreview } from "./link-preview.js";
import {
  resetLinkPreviewCacheForTest,
  type LinkPreviewPayload,
} from "../../link-preview/preview-service.js";
import { setAttachmentsDirForTest } from "./files.js";
import { clearFridayNextRuntime, setFridayNextRuntime } from "../../runtime.js";

const lookupMock = vi.mocked(dns.lookup);

class MockRes extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  end(body?: string): void {
    if (body) this.body += body;
    this.emit("finish");
  }
}

function makeReq(query: string | null, token: string | null = "tok"): IncomingMessage {
  return {
    method: "GET",
    url:
      query == null
        ? "/friday-next/link-preview"
        : `/friday-next/link-preview?url=${encodeURIComponent(query)}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as IncomingMessage;
}

async function invoke(req: IncomingMessage): Promise<MockRes> {
  const res = new MockRes();
  await handleLinkPreview(req, res as unknown as ServerResponse);
  return res;
}

const PAGE_HTML = `<html><head>
  <meta property="og:title" content="Hello Page">
  <meta property="og:description" content="A description">
  <meta property="og:site_name" content="Example Site">
  <meta property="og:image" content="https://example.com/cover.png">
</head></html>`;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]);

let tmpDir: string;

beforeEach(() => {
  resetLinkPreviewCacheForTest();
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "link-preview-test-"));
  setAttachmentsDirForTest(tmpDir);
  setFridayNextRuntime({
    config: { loadConfig: () => ({ gateway: { auth: { token: "tok" } }, channels: {} }) },
  } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setAttachmentsDirForTest(null);
  clearFridayNextRuntime();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("handleLinkPreview", () => {
  it("405 on non-GET", async () => {
    const res = new MockRes();
    await handleLinkPreview(
      { method: "POST", url: "/friday-next/link-preview", headers: {} } as never,
      res as never,
    );
    expect(res.statusCode).toBe(405);
  });

  it("401 without bearer token", async () => {
    const res = await invoke(makeReq("https://example.com/", null));
    expect(res.statusCode).toBe(401);
  });

  it("400 when url param is missing or not http(s)", async () => {
    expect((await invoke(makeReq(null))).statusCode).toBe(400);
    expect((await invoke(makeReq("ftp://example.com/x"))).statusCode).toBe(400);
    expect((await invoke(makeReq("not a url"))).statusCode).toBe(400);
  });

  it("403 blocked_url for private targets", async () => {
    const res = await invoke(makeReq("http://192.168.1.1/admin"));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe("blocked_url");
  });

  it("200 with full preview payload and re-hosted cover image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
        const url = String(input);
        if (url.includes("cover.png")) {
          return new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });
        }
        return new Response(PAGE_HTML, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }),
    );
    const res = await invoke(makeReq("https://example.com/article"));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; preview: LinkPreviewPayload };
    expect(body.ok).toBe(true);
    expect(body.preview.title).toBe("Hello Page");
    expect(body.preview.description).toBe("A description");
    expect(body.preview.siteName).toBe("Example Site");
    expect(body.preview.url).toBe("https://example.com/article");
    expect(body.preview.finalUrl).toBe("https://example.com/article");
    expect(body.preview.imageUrl).toMatch(/^\/friday-next\/files\/.+\.png$/);
    expect(typeof body.preview.fetchedAt).toBe("number");
    // 封面图确实落盘
    const token = decodeURIComponent(body.preview.imageUrl!.split("/").pop()!);
    expect(fs.existsSync(path.join(tmpDir, token))).toBe(true);
  });

  it("200 with imageUrl null when the cover download fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
        const url = String(input);
        if (url.includes("cover.png")) return new Response("nope", { status: 404 });
        return new Response(PAGE_HTML, { status: 200, headers: { "content-type": "text/html" } });
      }),
    );
    const res = await invoke(makeReq("https://example.com/article"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).preview.imageUrl).toBeNull();
  });

  it("falls back siteName to hostname when og:site_name is absent", async () => {
    const html = `<meta property="og:title" content="T">`;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
      ),
    );
    const res = await invoke(makeReq("https://example.com/x"));
    expect(JSON.parse(res.body).preview.siteName).toBe("example.com");
  });

  it("200 minimal hostname card when a reachable page has no OG metadata", async () => {
    // 可达但无 OG/title → 退到 hostname 卡片(不再折叠)。
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html><body>plain</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    const res = await invoke(makeReq("https://example.com/bare"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).preview.title).toBe("example.com");
  });

  it("ICO favicon re-hosted into iconUrl", async () => {
    const ICO_BYTES = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
        const url = String(input);
        if (url.includes("favicon")) {
          return new Response(ICO_BYTES, {
            status: 200,
            headers: { "content-type": "image/x-icon" },
          });
        }
        return new Response(`<meta property="og:title" content="Titled">`, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }),
    );
    const res = await invoke(makeReq("https://example.com/p"));
    const preview = JSON.parse(res.body).preview as LinkPreviewPayload;
    expect(preview.iconUrl).toMatch(/^\/friday-next\/files\/.+\.ico$/);
    const token = decodeURIComponent(preview.iconUrl!.split("/").pop()!);
    expect(fs.existsSync(path.join(tmpDir, token))).toBe(true);
  });

  it("200 minimal card for a bot-blocked page whose favicon.ico is reachable (zhihu-style)", async () => {
    const ICO_BYTES = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
        const url = String(input);
        if (url.endsWith("/favicon.ico")) {
          return new Response(ICO_BYTES, {
            status: 200,
            headers: { "content-type": "image/vnd.microsoft.icon" },
          });
        }
        return new Response("blocked", { status: 403, headers: { "content-type": "text/html" } }); // page blocks bots
      }),
    );
    const res = await invoke(makeReq("https://www.zhihu.com/question/123"));
    expect(res.statusCode).toBe(200);
    const preview = JSON.parse(res.body).preview as LinkPreviewPayload;
    expect(preview.title).toBe("www.zhihu.com");
    expect(preview.iconUrl).toMatch(/^\/friday-next\/files\/.+\.ico$/);
    expect(preview.imageUrl).toBeNull();
  });

  it("502 fetch_failed for a dead domain (page and favicon both fail)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    const res = await invoke(makeReq("https://dead.example.com/x"));
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).error).toBe("fetch_failed");
  });

  it("502 fetch_failed on non-2xx and non-HTML responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    expect((await invoke(makeReq("https://example.com/down"))).statusCode).toBe(502);

    resetLinkPreviewCacheForTest();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    expect((await invoke(makeReq("https://example.com/api"))).statusCode).toBe(502);
  });

  it("serves the second request from cache without refetching", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(`<meta property="og:title" content="Cached">`, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await invoke(makeReq("https://example.com/cached"));
    const afterFirst = fetchMock.mock.calls.length;
    const second = await invoke(makeReq("https://example.com/cached"));
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).preview.title).toBe("Cached");
    expect(fetchMock).toHaveBeenCalledTimes(afterFirst); // cached → no extra network
  });

  it("negative-caches failures", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await invoke(makeReq("https://example.com/flaky"));
    const afterFirst = fetchMock.mock.calls.length;
    await invoke(makeReq("https://example.com/flaky"));
    expect(fetchMock).toHaveBeenCalledTimes(afterFirst); // negative-cached → no refetch
  });
});
