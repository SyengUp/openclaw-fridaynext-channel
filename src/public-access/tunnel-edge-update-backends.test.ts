import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  PUBLIC_MARKER,
  startTunnelEdge,
  type TunnelBackend,
  type TunnelEdge,
} from "@syengup/tunnel-edge";

// `TunnelEdge.updateBackends` is the edge API the control-plane backend reconcile uses in
// in-process mode. Boot a real edge against two stub upstreams to prove validation failure is
// atomic, routing decisions hot-swap, removed paths 404, and the public marker keeps working.

let upstreamA: Server;
let upstreamB: Server;
let portA = 0;
let portB = 0;
let edge: TunnelEdge;
let edgePort = 0;
let hitsA: string[] = [];
let hitsB: string[] = [];
let markersB: Array<string | string[] | undefined> = [];

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.once("listening", () => resolve((server.address() as AddressInfo).port));
    server.listen(0, "127.0.0.1");
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

const backendA = (): TunnelBackend => ({
  id: "a",
  pathPrefixes: ["/a"],
  localPort: portA,
  requiresAttest: false,
});

const backendB = (): TunnelBackend => ({
  id: "b",
  pathPrefixes: ["/b"],
  localPort: portB,
  requiresAttest: false,
});

beforeAll(async () => {
  upstreamA = createServer((req, res) => {
    hitsA.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("A");
  });
  upstreamB = createServer((req, res) => {
    hitsB.push(req.url ?? "");
    markersB.push(req.headers[PUBLIC_MARKER]);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("B");
  });
  portA = await listen(upstreamA);
  portB = await listen(upstreamB);

  edge = startTunnelEdge({ listenPort: 0, backends: [backendA(), backendB()] });
  edgePort = await edge.port;
});

afterAll(async () => {
  edge.server.closeAllConnections();
  upstreamA.closeAllConnections();
  upstreamB.closeAllConnections();
  await edge.close();
  await new Promise<void>((r) => upstreamA.close(() => r()));
  await new Promise<void>((r) => upstreamB.close(() => r()));
});

describe("TunnelEdge.updateBackends (plugin reconcile primitive)", () => {
  it("rejects overlapping prefixes and leaves the current table serving", async () => {
    expect(() =>
      edge.updateBackends([
        { id: "c", pathPrefixes: ["/c"], localPort: portA, requiresAttest: false },
        { id: "d", pathPrefixes: ["/c/health"], localPort: portB, requiresAttest: false },
      ]),
    ).toThrowError(/overlapping path prefixes between tunnel backends "c" and "d".*\/c.*\/c\/health/);

    hitsA = [];
    hitsB = [];
    const [ra, rb] = await Promise.all([get("/a"), get("/b")]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(hitsA).toEqual(["/a"]);
    expect(hitsB).toEqual(["/b"]);
  });

  it("updates the routing decision in place", async () => {
    edge.updateBackends([{ id: "c", pathPrefixes: ["/c"], localPort: portB, requiresAttest: false }]);
    expect(edge.backends.map((b) => b.id)).toEqual(["c"]);

    const [oldA, oldB] = await Promise.all([get("/a"), get("/b")]);
    expect(oldA.status).toBe(404);
    expect(oldB.status).toBe(404);

    hitsB = [];
    const fresh = await get("/c");
    expect(fresh.status).toBe(200);
    expect(fresh.body).toBe("B");
    expect(hitsB).toEqual(["/c"]);
  });

  it("still stamps the public marker after an update, stripping client values", async () => {
    markersB = [];
    const res = await get("/c", { [PUBLIC_MARKER]: "forged" });
    expect(res.status).toBe(200);
    expect(markersB).toEqual(["1"]);
  });

  it("404s unknown paths after removal", async () => {
    expect((await get("/a/anything")).status).toBe(404);
  });
});
