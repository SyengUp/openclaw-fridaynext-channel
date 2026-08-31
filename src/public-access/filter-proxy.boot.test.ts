import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { startFilterProxy } from "./filter-proxy.js";
import { ATTEST_COOKIE, ATTEST_HEADER } from "../attest/attest-gate.js";

// The pure allowlist tables are covered in filter-proxy.test.ts. This suite boots the real
// proxy against a stub core, because the two things it pins can't be seen from a pure function:
// the UPGRADE path (previously a bare TCP reset with zero coverage) and the fact that a denied
// request never reaches core at all.

const GOOD = "tok-good";

let core: Server;
let corePort = 0;
let proxy: Server;
let proxyPort = 0;
let gateEnabled = true;
let coreHits: string[] = [];
const coreUpgradedSockets: Socket[] = [];
let lastCoreHeaders: IncomingHttpHeaders = {};

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve) => {
    server.once("listening", () => resolve((server.address() as AddressInfo).port));
    if (!server.listening) server.listen(port, "127.0.0.1");
  });
}

function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxyPort, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Resolves with 101 when the upgrade completed, or the HTTP status the proxy answered with. */
function upgrade(path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: proxyPort,
      path,
      headers: { Connection: "Upgrade", Upgrade: "websocket", ...headers },
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  core = createServer((req, res) => {
    coreHits.push(req.url ?? "");
    lastCoreHeaders = { ...req.headers };
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("core");
  });
  core.on("upgrade", (req, socket) => {
    coreHits.push(`UPGRADE ${req.url ?? ""}`);
    lastCoreHeaders = { ...req.headers };
    // An upgraded socket is detached from the http server, so closeAllConnections() can't reach
    // it — the stub has to hold on to it and destroy it itself at teardown.
    coreUpgradedSockets.push(socket);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
  });
  corePort = await listen(core, 0);

  proxy = startFilterProxy(0, corePort, () => {}, {
    enabled: () => gateEnabled,
    verify: (t) => t === GOOD,
  });
  proxyPort = await listen(proxy, 0);
});

afterAll(async () => {
  // Keep-alive sockets hold `close()` open forever otherwise.
  for (const s of coreUpgradedSockets) s.destroy();
  proxy.closeAllConnections();
  core.closeAllConnections();
  await new Promise<void>((r) => proxy.close(() => r()));
  await new Promise<void>((r) => core.close(() => r()));
});

describe("filter proxy attest gate — HTTP", () => {
  it("403s the canvas surface with no credential, and core never sees it", async () => {
    coreHits = [];
    const res = await get("/__openclaw__/a2ui/app.js");
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: "app attestation required",
      code: "attest_required",
    });
    expect(coreHits).toEqual([]);
  });

  it("passes the canvas surface when the sub-resource carries the cookie", async () => {
    const res = await get("/__openclaw__/a2ui/app.js", { Cookie: `${ATTEST_COOKIE}=${GOOD}` });
    expect(res.status).toBe(200);
  });

  it("passes the canvas surface for a header-carrying request", async () => {
    const res = await get("/__openclaw__/a2ui/", { [ATTEST_HEADER]: GOOD });
    expect(res.status).toBe(200);
  });

  it("leaves the plugin prefix to the plugin's own gate (pairing must stay reachable)", async () => {
    expect((await get("/friday-next/pair/claim")).status).toBe(200);
    expect((await get("/friday-next/messages")).status).toBe(200);
  });

  it("still 404s a denied path, gate or not", async () => {
    expect((await get("/__openclaw__/control")).status).toBe(404);
    expect((await get("/chat")).status).toBe(404);
  });
});

describe("filter proxy attest gate — WebSocket upgrade", () => {
  it("answers 403 instead of resetting the socket when the header is missing", async () => {
    coreHits = [];
    expect(await upgrade("/gateway")).toBe(403);
    expect(coreHits).toEqual([]);
  });

  it("rejects a forged token", async () => {
    expect(await upgrade("/gateway", { [ATTEST_HEADER]: "forged" })).toBe(403);
  });

  it("rejects the canvas cookie on the node WebSocket", async () => {
    expect(await upgrade("/gateway", { Cookie: `${ATTEST_COOKIE}=${GOOD}` })).toBe(403);
  });

  it("upgrades with a valid token", async () => {
    expect(await upgrade("/gateway", { [ATTEST_HEADER]: GOOD })).toBe(101);
  });
});

describe("filter proxy strips forwarded client headers before core", () => {
  const frpcHeaders = {
    "X-Forwarded-For": "1.2.3.4",
    "X-Real-IP": "1.2.3.4",
    Forwarded: "for=1.2.3.4",
    "X-Forwarded-Proto": "https",
    "X-Forwarded-Host": "fn.example.host",
  };

  function expectCoreDidNotSeeForwardedHeaders() {
    expect(lastCoreHeaders["x-forwarded-for"]).toBeUndefined();
    expect(lastCoreHeaders["x-real-ip"]).toBeUndefined();
    expect(lastCoreHeaders.forwarded).toBeUndefined();
    expect(lastCoreHeaders["x-forwarded-proto"]).toBeUndefined();
    expect(lastCoreHeaders["x-forwarded-host"]).toBeUndefined();
    expect(lastCoreHeaders["x-fridaynext-public"]).toBe("1");
  }

  it("HTTP hop looks local-direct to OpenClaw 2026.8.1", async () => {
    const res = await get("/friday-next/health", frpcHeaders);
    expect(res.status).toBe(200);
    expectCoreDidNotSeeForwardedHeaders();
  });

  it("WebSocket hop looks local-direct to OpenClaw 2026.8.1", async () => {
    expect(await upgrade("/gateway", { [ATTEST_HEADER]: GOOD, ...frpcHeaders })).toBe(101);
    expectCoreDidNotSeeForwardedHeaders();
  });
});

describe("filter proxy attest gate — disabled", () => {
  it("falls back to bearer-only behaviour on both surfaces", async () => {
    gateEnabled = false;
    try {
      expect((await get("/__openclaw__/a2ui/")).status).toBe(200);
      expect(await upgrade("/gateway")).toBe(101);
    } finally {
      gateEnabled = true;
    }
  });
});
