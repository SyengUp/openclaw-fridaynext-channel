import { afterEach, describe, expect, it } from "vitest";
import { createServer, get as httpGet, request as httpRequest, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { startFilterProxy, stopFilterProxy } from "./filter-proxy.js";

// Regression: stopping the proxy must free the listen port even while a relayed SSE stream
// (a never-ending response — exactly what /friday-next/events looks like through frpc) and a
// tunnelled WebSocket are still open. Plain server.close() waits for both forever, the port
// (corePort+1) stayed bound, and the next tunnel activation retried EADDRINUSE every 60s
// against the corpse.

const servers: Server[] = [];
const sockets: Socket[] = [];

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function listenOnce(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.once("listening", () => resolve((server.address() as AddressInfo).port));
  });
}

/** Resolves with the upgraded client socket on 101. */
function upgrade(port: number, path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      headers: { Connection: "Upgrade", Upgrade: "websocket" },
    });
    req.on("upgrade", (_res, socket) => resolve(socket));
    req.on("response", (res) => {
      res.resume();
      reject(new Error(`upgrade refused: ${res.statusCode}`));
    });
    req.on("error", reject);
    req.end();
  });
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const srv of servers.splice(0)) {
    try {
      srv.closeAllConnections();
    } catch {
      /* not running */
    }
    if (srv.listening) await new Promise<void>((r) => srv.close(() => r()));
  }
});

describe("stopFilterProxy", () => {
  it("frees the listen port while a relayed SSE stream is still flowing", async () => {
    const core = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: ping\ndata: {}\n\n"); // stream stays open — no res.end()
    });
    servers.push(core);
    const corePort = await listen(core, 0);

    const proxy = startFilterProxy(0, corePort, () => {});
    servers.push(proxy);
    const port = await listenOnce(proxy);

    // Open the never-ending stream through the proxy and hold it, unread.
    await new Promise<void>((resolve, reject) => {
      const req = httpGet({ host: "127.0.0.1", port, path: "/friday-next/events" }, (res) => {
        res.on("error", () => {});
        res.once("data", () => {
          res.pause();
          if (res.socket) sockets.push(res.socket);
          resolve();
        });
      });
      req.on("error", () => {}); // the forced destroy below is expected
      req.end();
    });

    stopFilterProxy(proxy);

    // The port must be rebindable promptly — this is the exact bind the next activation does.
    const rebind = createServer();
    servers.push(rebind);
    const rebound = await Promise.race([
      listen(rebind, port).then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 2000)),
    ]);
    expect(rebound).toBe(true);
  });

  it("destroys tunnelled WebSocket sockets so close() can complete", async () => {
    const core = createServer();
    core.on("upgrade", (_req, socket) => {
      sockets.push(socket); // detached from core too; clean up in afterEach
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
    });
    servers.push(core);
    const corePort = await listen(core, 0);

    const proxy = startFilterProxy(0, corePort, () => {});
    servers.push(proxy);
    const port = await listenOnce(proxy);

    const client = await upgrade(port, "/gateway");
    sockets.push(client);
    const closed = new Promise<boolean>((resolve) => {
      client.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 2000);
    });

    stopFilterProxy(proxy);
    expect(await closed).toBe(true);
  });

  it("disarms a pending rebind so a stopped proxy never comes back to life", async () => {
    const squatter = createServer();
    servers.push(squatter);
    const port = await listen(squatter, 0);

    // First bind fails with EADDRINUSE and arms the retry loop.
    const proxy = startFilterProxy(port, port + 1, () => {});
    servers.push(proxy);
    await new Promise((r) => setTimeout(r, 100));
    expect(proxy.listening).toBe(false);

    stopFilterProxy(proxy);

    // Even after the squatter frees the port, the stopped proxy must not grab it.
    await new Promise<void>((r) => squatter.close(() => r()));
    await new Promise((r) => setTimeout(r, 1500));
    expect(proxy.listening).toBe(false);

    const probe = createServer();
    servers.push(probe);
    expect(await listen(probe, port)).toBe(port);
  });
});
