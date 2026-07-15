/**
 * Public-surface allowlist proxy.
 *
 * The frpc `https2http` tunnel would otherwise forward the ENTIRE core HTTP surface
 * to the public internet — including `/`, `/chat` (chat web UI) and `/control`
 * (ControlUI admin panel). Those must never be publicly reachable.
 *
 * This tiny reverse proxy sits between frpc (public TLS termination) and core:
 * frpc → filter proxy → core. It forwards ONLY the app-facing paths and 404s the
 * rest, so the public tunnel exposes just the FridayNext API + node WebSocket.
 * LAN clients hit core directly and are unaffected.
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as netConnect } from "node:net";

// Everything the app needs over the public relay; nothing else reaches core.
//   /friday-next/*        REST + SSE (attest-gated by the plugin)
//   /friday-next-admin/*  session delete (gateway-authed)
//   /gateway              node WebSocket (device-authed handshake)
//   /__openclaw__/*       canvas + a2ui surface loaded by the in-app WKWebView
//                         (core-auth-gated; the app attaches a Bearer token)
const ALLOW = [
  /^\/friday-next(\/|$)/,
  /^\/friday-next-admin(\/|$)/,
  /^\/gateway(\/|$)/,
  /^\/__openclaw__(\/|$)/,
];

// DENY wins over ALLOW. The __openclaw__ namespace ALSO hosts the ControlUI admin
// panel plus config/api surfaces — and the core serves /__openclaw__/control and
// the bare /__openclaw__/ index WITHOUT auth (200 to an anonymous request). Those
// must never reach the public tunnel even though the canvas surface shares the
// prefix. The canvas/a2ui pages the app needs live under other sub-paths and are
// themselves core-auth-gated, so this carve-out doesn't touch them.
const DENY = [
  /^\/__openclaw__\/control(\/|$)/,
  /^\/__openclaw__\/config(\/|$)/,
  /^\/__openclaw__\/api(\/|$)/,
  /^\/__openclaw__\/?$/, // bare index/landing — canvas never requests it
];

/**
 * Normalize the path BEFORE matching so `..`, `%2e%2e`, and `//` can't smuggle a
 * denied path past the allowlist (the core resolves those, so we must too).
 */
function normalizedPath(rawUrl: string): string {
  try {
    let p = new URL(rawUrl, "http://x").pathname; // strips query, resolves ./ and ../
    try {
      p = new URL(decodeURIComponent(p), "http://x").pathname; // catch %2e-encoded traversal
    } catch {
      /* malformed escape — keep the already-parsed pathname */
    }
    return p.replace(/\/{2,}/g, "/");
  } catch {
    return "/";
  }
}

function allowed(url: string): boolean {
  const p = normalizedPath(url);
  if (DENY.some((re) => re.test(p))) return false;
  return ALLOW.some((re) => re.test(p));
}

export function startFilterProxy(listenPort: number, corePort: number, log: (m: string) => void): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (!allowed(url)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const upstream = httpRequest(
      { host: "127.0.0.1", port: corePort, method: req.method, path: url, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res); // streams SSE too
      },
    );
    upstream.setTimeout(0); // long-lived SSE must not time out
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  // WebSocket / other HTTP upgrades (the node channel at /gateway).
  server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "/";
    if (!allowed(url)) {
      socket.destroy();
      return;
    }
    const up = netConnect(corePort, "127.0.0.1", () => {
      up.write(`${req.method} ${url} HTTP/1.1\r\n`);
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        up.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      }
      up.write("\r\n");
      if (head && head.length) up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });

  server.listen(listenPort, "127.0.0.1", () => {
    log(`public surface filter on 127.0.0.1:${listenPort} → core:${corePort} (allowlist only)`);
  });
  return server;
}
