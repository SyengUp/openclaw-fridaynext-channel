import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  ATTEST_COOKIE,
  ATTEST_HEADER,
  PUBLIC_MARKER,
  matchesPrefix,
  normalizedPath,
  resolveBackendForPath,
  startTunnelEdge,
  type TunnelBackend,
  type TunnelEdge,
} from "@fridaynext/tunnel-edge";

// The OpenClaw backend config the edge is booted with must preserve every historical
// filter-proxy behavior: segment-bounded allowlist, deny-beats-allow, the bare /__openclaw__
// carve-out, pre-token bootstrap routes, and the marker/attest behavior on HTTP + upgrade.

export const openclawBackend: TunnelBackend = {
  id: "openclaw",
  pathPrefixes: ["/friday-next", "/friday-next-admin", "/gateway", "/__openclaw__"],
  localPort: 18789,
  requiresAttest: true,
  denyPrefixes: [
    "/__openclaw__/control",
    "/__openclaw__/config",
    "/__openclaw__/api",
    "/__openclaw__",
  ],
  attestExemptPaths: [
    "/friday-next/attest",
    "/friday-next/health",
    "/friday-next/status",
    "/friday-next/plugin/info",
    "/friday-next/public-access/pairing",
    "/friday-next/pair/claim",
  ],
};

describe("openclaw tunnel-edge routing (pure)", () => {
  it("normalizes paths exactly like the legacy filter proxy", () => {
    expect(normalizedPath("/friday-next/health?x=1")).toBe("/friday-next/health");
    expect(normalizedPath("/friday-next/../__openclaw__/control")).toBe("/__openclaw__/control");
    expect(normalizedPath("/friday-next/%2e%2e/__openclaw__/control")).toBe(
      "/__openclaw__/control",
    );
    expect(normalizedPath("/friday-next//events")).toBe("/friday-next/events");
  });

  it("allows the app surface", () => {
    for (const p of [
      "/friday-next/health",
      "/friday-next/events",
      "/friday-next/pair/claim",
      "/friday-next-admin/sessions?sessionKey=x",
      "/gateway",
      "/__openclaw__/a2ui/page",
    ]) {
      expect(resolveBackendForPath(p, [openclawBackend])?.id, p).toBe("openclaw");
    }
  });

  it("denies everything else", () => {
    for (const p of [
      "/",
      "/chat",
      "/control",
      "/friday-nextx/evil",
      "/__openclaw__/control",
      "/__openclaw__/control/panel",
      "/__openclaw__/config/dump",
      "/__openclaw__/api/anything",
      "/__openclaw__",
      "/__openclaw__/",
    ]) {
      expect(resolveBackendForPath(p, [openclawBackend]), p).toBeNull();
    }
  });

  it("denies traversal-smuggled control paths", () => {
    expect(
      resolveBackendForPath("/friday-next/../__openclaw__/control", [openclawBackend]),
    ).toBeNull();
    expect(
      resolveBackendForPath("/friday-next/%2e%2e/__openclaw__/control", [openclawBackend]),
    ).toBeNull();
    expect(resolveBackendForPath("/__openclaw__//control", [openclawBackend])).toBeNull();
  });

  it("matches /cap segment boundaries (generic edge primitive)", () => {
    expect(matchesPrefix("/cap", "/cap")).toBe(true);
    expect(matchesPrefix("/cap/", "/cap")).toBe(true);
    expect(matchesPrefix("/cap/hello", "/cap")).toBe(true);
    expect(matchesPrefix("/capsule", "/cap")).toBe(false);
  });
});

describe("openclaw tunnel-edge boot", () => {
  const GOOD = "tok-good";
  let core: Server;
  let corePort = 0;
  let edge: TunnelEdge;
  let edgePort = 0;
  const gateEnabled = true;
  let coreHits: string[] = [];
  let coreMarkers: Array<string | string[] | undefined> = [];
  const coreUpgradedSockets: Socket[] = [];

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
      const req = request({ host: "127.0.0.1", port: edgePort, path, headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  function upgrade(path: string, headers: Record<string, string> = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: edgePort,
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
      coreMarkers.push(req.headers[PUBLIC_MARKER]);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("core");
    });
    core.on("upgrade", (req, socket) => {
      coreHits.push(`UPGRADE ${req.url ?? ""}`);
      coreUpgradedSockets.push(socket);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
    });
    corePort = await listen(core, 0);

    edge = startTunnelEdge({
      listenPort: 0,
      backends: [{ ...openclawBackend, localPort: corePort }],
      attestGate: {
        enabled: () => gateEnabled,
        verify: (t) => t === GOOD,
      },
    });
    edgePort = await edge.port;
  });

  afterAll(async () => {
    for (const socket of coreUpgradedSockets) socket.destroy();
    edge.server.closeAllConnections();
    core.closeAllConnections();
    await edge.close();
    await new Promise<void>((r) => core.close(() => r()));
  });

  it("stamps the public marker after stripping any client-supplied value", async () => {
    coreMarkers = [];
    expect((await get("/friday-next/health", { [PUBLIC_MARKER]: "forged" })).status).toBe(200);
    expect(coreMarkers).toEqual(["1"]);
  });

  it("still 404s a denied path, gate or not", async () => {
    coreHits = [];
    expect((await get("/__openclaw__/control")).status).toBe(404);
    expect((await get("/chat")).status).toBe(404);
    expect(coreHits).toEqual([]);
  });

  it("403s a gated plugin path with no credential, and core never sees it", async () => {
    coreHits = [];
    const res = await get("/friday-next/messages");
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: "app attestation required",
      code: "attest_required",
    });
    expect(coreHits).toEqual([]);
  });

  it("keeps pre-token bootstrap routes reachable through the edge", async () => {
    expect((await get("/friday-next/pair/claim")).status).toBe(200);
  });

  it("passes the canvas surface for a header-carrying request", async () => {
    expect((await get("/__openclaw__/a2ui/", { [ATTEST_HEADER]: GOOD })).status).toBe(200);
  });

  it("passes the canvas surface when the sub-resource carries the cookie", async () => {
    expect(
      (await get("/__openclaw__/a2ui/app.js", { Cookie: `${ATTEST_COOKIE}=${GOOD}` })).status,
    ).toBe(200);
  });

  it("answers 403 instead of resetting the socket when the WebSocket header is missing", async () => {
    coreHits = [];
    expect(await upgrade("/gateway")).toBe(403);
    expect(coreHits).toEqual([]);
  });

  it("rejects the canvas cookie on the node WebSocket", async () => {
    expect(await upgrade("/gateway", { Cookie: `${ATTEST_COOKIE}=${GOOD}` })).toBe(403);
  });

  it("upgrades with a valid token and stamps the marker", async () => {
    expect(await upgrade("/gateway", { [ATTEST_HEADER]: GOOD })).toBe(101);
  });
});
