import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import {
  uploadOutboundMedia,
  downloadInboundMedia,
  isOSSAttachmentRef,
  encodeRefURI,
  decodeRefURI,
  type OSSTransferConfig,
} from "./oss-transfer.js";
import { decryptAttachment } from "./attachment-crypto.js";

// A tiny fake "control plane + OSS" in one process: POST /v1/oss/sign returns a URL that points
// back at this same server's /blob/<objectId>; PUT stores ciphertext; GET returns it.
function startFakeStack(): Promise<{ base: string; close: () => void; blobs: Map<string, Buffer> }> {
  const blobs = new Map<string, Buffer>();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname === "/v1/oss/sign" && req.method === "POST") {
      let body = "";
      for await (const c of req) body += c;
      const b = JSON.parse(body || "{}");
      if (!b.gatewayKey) {
        res.writeHead(401);
        return res.end();
      }
      const objectId = b.objectId;
      const signed = {
        objectKey: `att/x/${objectId}`,
        url: `${base}/blob/${objectId}?sig=x`,
        headers: {},
        expiresAt: Date.now() + 900_000,
      };
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(signed));
    }
    if (url.pathname === "/v1/oss/sign503" && req.method === "POST") {
      res.writeHead(503, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "oss_not_configured" }));
    }
    const m = /^\/blob\/(.+)$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        blobs.set(id, Buffer.concat(chunks));
        res.writeHead(200);
        return res.end();
      }
      if (req.method === "GET") {
        const buf = blobs.get(id);
        if (!buf) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end(buf);
      }
    }
    res.writeHead(404);
    res.end();
  });
  let base = "";
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      base = `http://127.0.0.1:${port}`;
      resolve({ base, close: () => server.close(), blobs });
    });
  });
}

describe("plugin OSS transfer (Phase E5)", () => {
  let stack: Awaited<ReturnType<typeof startFakeStack>>;
  let cfg: OSSTransferConfig;

  beforeAll(async () => {
    stack = await startFakeStack();
    cfg = { controlPlaneUrl: stack.base, authToken: "gw-token" };
  });
  afterAll(() => stack.close());

  it("uploads encrypted, returns a tunnel ref, and stores only ciphertext", async () => {
    const pt = Buffer.from("outbound image bytes 星期五", "utf8");
    const ref = await uploadOutboundMedia(cfg, pt, { name: "out.png", mime: "image/png", isImage: true });
    expect(ref).not.toBeNull();
    expect(isOSSAttachmentRef(ref)).toBe(true);
    expect(ref!.size).toBe(pt.length);
    // The stored object is ciphertext (FNEA), never the plaintext.
    const stored = stack.blobs.get(ref!.objectId)!;
    expect(stored.subarray(0, 4).toString("ascii")).toBe("FNEA");
    expect(stored.equals(pt)).toBe(false);
    // The app would decrypt it with the ref's key — verify locally.
    const key = Buffer.from(ref!.key, "base64");
    expect(decryptAttachment(stored, key).equals(pt)).toBe(true);
  });

  it("round-trips upload → downloadInbound", async () => {
    const pt = Buffer.from("a".repeat(200_000), "utf8"); // multi-frame
    const ref = await uploadOutboundMedia(cfg, pt, { name: "big.bin", mime: "application/octet-stream", isImage: false });
    const got = await downloadInboundMedia(cfg, ref!);
    expect(got!.equals(pt)).toBe(true);
  });

  it("falls back (null) when the control plane returns 503", async () => {
    const bad: OSSTransferConfig = { controlPlaneUrl: `${stack.base}/__nope`, authToken: "gw-token" };
    const ref = await uploadOutboundMedia(bad, Buffer.from("x"), { name: "a", mime: "text/plain", isImage: false });
    expect(ref).toBeNull();
  });

  it("rejects a non-ref", () => {
    expect(isOSSAttachmentRef({ objectId: "x" })).toBe(false);
    expect(isOSSAttachmentRef(null)).toBe(false);
    expect(isOSSAttachmentRef({ oss: 1, objectId: "x", key: "k" })).toBe(true);
  });
});

describe("fnoss URI codec (Phase E wiring bridge)", () => {
  const ref = {
    oss: 1 as const, objectId: "abc123",
    key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    mime: "image/png", name: "p.png", size: 42, isImage: true,
  };

  it("round-trips encode → decode", () => {
    const uri = encodeRefURI(ref);
    expect(uri.startsWith("fnoss:v1:")).toBe(true);
    expect(decodeRefURI(uri)).toEqual(ref);
  });

  it("rejects non-fnoss / garbage", () => {
    expect(decodeRefURI("https://x/y")).toBeNull();
    expect(decodeRefURI("fnoss:v1:@@@notb64@@@")).toBeNull();
    expect(decodeRefURI("fnoss:v1:" + Buffer.from('{"oss":2}').toString("base64url"))).toBeNull();
  });

  it("INTEROP: decodes a Swift-produced fnoss URI", () => {
    // Emitted by the app test OSSAttachmentRefURITests.testEmitSwiftURIForPlugin. Swift's JSON
    // escapes "/" and orders keys differently, but decode is order-independent.
    const swiftURI =
      "fnoss:v1:eyJvYmplY3RJZCI6ImFiYzEyMyIsImtleSI6IkFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE9IiwibWltZSI6ImltYWdlXC9wbmciLCJvc3MiOjEsInNpemUiOjQyLCJpc0ltYWdlIjp0cnVlLCJuYW1lIjoicC5wbmcifQ";
    const decoded = decodeRefURI(swiftURI);
    expect(decoded?.objectId).toBe("abc123");
    expect(decoded?.key).toBe(ref.key);
    expect(decoded?.mime).toBe("image/png");
    expect(decoded?.isImage).toBe(true);
  });
});
