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
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import { attestGateDecision, ATTEST_REJECTION_BODY } from "../attest/attest-gate.js";

/** Per-server forced-shutdown hook, registered by `startFilterProxy` (see `stopFilterProxy`). */
const shutdownHooks = new WeakMap<Server, () => void>();

/**
 * Force the proxy down AND free its listen port. Plain `server.close()` waits for existing
 * connections to end — and the connections this proxy carries are frpc-relayed SSE streams
 * (`/friday-next/events`, `setTimeout(0)`) that frpc holds open for hours, so close() never
 * completed, `corePort+1` stayed bound, and the next tunnel activation retried EADDRINUSE
 * every 60s against its own corpse. Destroy every connection class instead: in-flight HTTP
 * (closeAllConnections covers the flowing SSE responses), idle keep-alives, and the upgraded
 * sockets — which closeAllConnections can't reach because they're detached from the server on
 * upgrade. Also cancels any pending rebind from the error-retry loop below.
 */
export function stopFilterProxy(server: Server): void {
  const hook = shutdownHooks.get(server);
  if (hook) {
    hook();
    return;
  }
  try {
    server.close();
  } catch {
    /* not running */
  }
}

// Trusted "this request arrived via the public relay" marker. EVERY public request
// must traverse this proxy (frpc forwards only here), so stamping it here — after
// stripping any client-supplied value — makes it unforgeable from the outside. The
// plugin's App Attest gate enforces ONLY when this marker is present, so the gate
// scopes to the public surface and never touches LAN clients hitting core directly.
const PUBLIC_MARKER = "x-fridaynext-public";

/**
 * Headers OpenClaw 2026.8.1 treats as "proxy-shaped" (`hasForwardedRequestHeaders`).
 * frpc `https2http` injects these on the loopback hop into this proxy; if we
 * forward them to core, core sees `127.0.0.1` + X-Forwarded-* and rejects
 * Gateway-authenticated routes (`/gateway` node WS) with
 * `proxy_attribution_required`. This proxy is already the trust boundary
 * (allowlist + attest), so strip them and let core treat the hop as local-direct.
 * Plugin routes (`/friday-next/*`) ignore untrusted forwarded claims anyway.
 */
export function isForwardedClientHeader(name: string): boolean {
  const n = name.toLowerCase();
  return n === "forwarded" || n === "x-real-ip" || n.startsWith("x-forwarded-");
}

function stripForwardedClientHeaders(headers: IncomingHttpHeaders): void {
  for (const key of Object.keys(headers)) {
    if (isForwardedClientHeader(key)) delete headers[key];
  }
}

// Everything the app needs over the public relay; nothing else reaches core.
//   /friday-next/*        REST + SSE (attest-gated by the plugin, downstream)
//   /friday-next-admin/*  session delete (gateway-authed + attest-gated by its handler)
//   /gateway              node WebSocket (device-authed handshake) — attest-gated HERE
//   /__openclaw__/*       canvas + a2ui surface loaded by the in-app WKWebView — attest-gated HERE
//
// The last two are core-owned routes: the plugin registers no handler for them, so its gate
// never sees them and this proxy is the only place they can be gated at all. Before that gate
// existed, a leaked gateway bearer reached the node WebSocket and the whole canvas surface from
// the public internet — and canvas sub-resources carried no credential whatsoever, because
// WebKit does not propagate the top-level navigation's headers to them (hence the cookie).
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
export function normalizedPath(rawUrl: string): string {
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

export function allowed(url: string): boolean {
  const p = normalizedPath(url);
  if (DENY.some((re) => re.test(p))) return false;
  return ALLOW.some((re) => re.test(p));
}

/** App Attest enforcement for the core-owned surfaces, injected so this module stays free of
 * `attest-store`'s module-level state and disk IO (and so it can be tested without either). */
export type ProxyAttestGate = {
  /** `appAttest.gatePublicSurfaces` — read per request so flipping config needs no restart. */
  enabled(): boolean;
  verify(token: string): boolean;
};

export function startFilterProxy(
  listenPort: number,
  corePort: number,
  log: (m: string) => void,
  gate?: ProxyAttestGate,
): Server {
  /** Everything reaching this proxy arrived via the relay, so `isPublic` is true by construction. */
  const rejectsAttest = (req: {
    url?: string;
    headers: Record<string, string | string[] | undefined>;
  }): boolean => {
    if (!gate?.enabled()) return false;
    return (
      attestGateDecision({
        pathname: normalizedPath(req.url ?? "/"),
        headers: req.headers,
        isPublic: true,
        required: true,
        scope: "proxy",
        verify: (t) => gate.verify(t),
      }) === "reject"
    );
  };

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (!allowed(url)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    if (rejectsAttest(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify(ATTEST_REJECTION_BODY));
      return;
    }
    // Overwrite any client-supplied marker with our trusted one (Node lowercases
    // header keys, so this covers every casing the client could have sent).
    req.headers[PUBLIC_MARKER] = "1";
    stripForwardedClientHeaders(req.headers);
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

  // Upgraded sockets are detached from the http server on 'upgrade', so neither close() nor
  // closeAllConnections() reaches them — track them ourselves for stopFilterProxy.
  const upgradedSockets = new Set<Duplex>();

  // WebSocket / other HTTP upgrades (the node channel at /gateway).
  server.on("upgrade", (req, socket, head) => {
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
    const url = req.url ?? "/";
    if (!allowed(url)) {
      socket.destroy();
      return;
    }
    if (rejectsAttest(req)) {
      // Answer before upgrading — nothing has been written to the client socket yet. A bare
      // destroy() (what a denied path gets) is an unexplained TCP reset the app would retry
      // forever; core answers its own unauthorized upgrades the same write-then-close way.
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    const up = netConnect(corePort, "127.0.0.1", () => {
      up.write(`${req.method} ${url} HTTP/1.1\r\n`);
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        // Drop any client-supplied marker; we append our own trusted one below.
        if (name.toLowerCase() === PUBLIC_MARKER) continue;
        if (isForwardedClientHeader(name)) continue;
        up.write(`${name}: ${req.rawHeaders[i + 1]}\r\n`);
      }
      up.write(`X-FridayNext-Public: 1\r\n`);
      up.write("\r\n");
      if (head && head.length) up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    });
    // Tie the two sockets' lifetimes — for a tunnelled WebSocket a half-open direction is
    // meaningless, so EOF from either side ends both.
    //
    // Without the `end` hooks the pair leaked: the app going away (FIN) made `pipe` end only the
    // WRITE side upstream; core keeps its half open, so this socket never became "closed", the
    // http server kept counting it, and `filterServer.close()` on standby/stop never completed —
    // leaving `corePort+1` bound so the next activation fought EADDRINUSE against its own corpse.
    const closeBoth = (): void => {
      socket.destroy();
      up.destroy();
    };
    up.on("error", closeBoth);
    socket.on("error", closeBoth);
    up.on("end", closeBoth);
    socket.on("end", closeBoth);
    up.on("close", closeBoth);
    socket.on("close", closeBoth);
  });

  // Without a listener, a listen failure (EADDRINUSE on the hardcoded corePort+1, …) throws
  // uncaughtException and takes down the ENTIRE host gateway for an accessory feature.
  //
  // Logging alone wasn't enough either: frpc stays registered and happily forwards into a port
  // nothing is listening on, so the relay believes the tunnel is up while every public request
  // dies — and the health watchdog can't tell, because frpc still answers (with an error). Retry
  // the bind with backoff so a transient conflict heals without a gateway restart.
  let retryDelayMs = 1_000;
  const maxRetryDelayMs = 60_000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const listen = (): void => {
    if (closed) return;
    server.listen(listenPort, "127.0.0.1");
  };
  server.on("error", (err) => {
    log(
      `public surface filter error: ${err.message} — rebinding in ${Math.round(retryDelayMs / 1000)}s`,
    );
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryDelayMs = Math.min(retryDelayMs * 2, maxRetryDelayMs);
      listen();
    }, retryDelayMs);
    retryTimer.unref?.();
  });
  server.on("listening", () => {
    retryDelayMs = 1_000;
    log(`public surface filter on 127.0.0.1:${listenPort} → core:${corePort} (allowlist only)`);
  });
  server.on("close", () => {
    closed = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  });
  shutdownHooks.set(server, () => {
    closed = true; // also disarms a pending rebind (listen() no-ops once closed)
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    try {
      server.close();
    } catch {
      /* not running */
    }
    try {
      server.closeAllConnections(); // in-flight SSE responses held open by frpc
      server.closeIdleConnections();
    } catch {
      /* not running */
    }
    for (const s of upgradedSockets) s.destroy();
    upgradedSockets.clear();
  });
  listen();
  return server;
}
