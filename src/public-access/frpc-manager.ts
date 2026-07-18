/**
 * Public access (FridayNext 云) — frpc tunnel manager.
 *
 * Makes the local OpenClaw gateway reachable from the public internet through the relay, WITHOUT
 * the relay ever decrypting: frpc terminates TLS locally with a self-signed cert (the `https2http`
 * plugin) and forwards plain HTTP to core `:corePort`; the relay's frps does SNI passthrough only.
 * The app pins the self-signed leaf fingerprint (delivered in the pairing QR superset), so the
 * TLS is end-to-end to this machine.
 *
 * Lifecycle: `startPublicAccess()` ensures the frpc binary (download + checksum), a persisted
 * self-signed cert, and a stable subdomain, writes the frpc config, and spawns frpc with a
 * keepalive respawn. `stopPublicAccess()` tears it down. All state lives under
 * `~/.openclaw/friday-next/public-access/`.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { request as httpsRequest } from "node:https";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { homedir, platform, arch, networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { startFilterProxy } from "./filter-proxy.js";

const FRP_VERSION = "0.69.1";
const DATA_DIR = join(homedir(), ".openclaw", "friday-next", "public-access");

export type PublicAccessConfig = {
  enabled: boolean;
  /** frps address `host:port`. */
  relayAddr: string;
  /** frps auth token (shared secret for the bare-test phase; per-user later via control plane). */
  relayToken: string;
  /** Wildcard base — frps `subDomainHost`. Public URL = `<subdomain>.<subDomainHost>`. */
  subDomainHost: string;
  /** Fixed subdomain; when absent, allocated from the relay registry (collision-proof). */
  subdomain?: string;
  /** Relay subdomain-allocator endpoint. The single authority that guarantees unique
   * subdomains: same gateway key → same subdomain, distinct keys → distinct, never a dup. */
  allocatorUrl: string;
  /** Relay cert-signing endpoint. Signs this gateway's CSR into a real Let's Encrypt
   * cert (browser-trusted) without the relay ever seeing the private key. */
  certSignUrl: string;
  /** Control-plane base (no `/v1`). Polled for the per-Apple-ID subdomains this gateway
   * should serve (D31). */
  controlPlaneUrl: string;
  /** Core gateway HTTP port to expose. */
  corePort: number;
  /** Bearer token the app uses (from the channel config). */
  authToken: string;
};

export type PairingInfo = {
  v: number;
  lanUrl: string;
  publicUrl: string;
  fingerprint: string;
  token: string;
  subdomain: string;
};

type Logger = (msg: string) => void;

let child: ChildProcess | null = null;
let filterServer: Server | null = null;
let stopped = false;

/** Local port of the public-surface filter proxy that frpc forwards into (core + 1). */
function filterPort(corePort: number): number {
  return corePort + 1;
}
let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
let allocRetryTimer: ReturnType<typeof setTimeout> | null = null;
let cachedPairing: PairingInfo | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let certRenewalTimer: ReturnType<typeof setInterval> | null = null;
let subdomainPollTimer: ReturnType<typeof setInterval> | null = null;
// D31: the gateway's base tunnel (from resolveSubdomain) + the full set of subdomains currently
// written into frpc.toml (base + per-Apple-ID). The poll reconciles the set against the control
// plane; `spawnConfPath` is what the keepalive respawns from.
let baseTunnel: { sub: string; crt: string; key: string; cn: string } | null = null;
let servedSubdomains: string[] = [];
let spawnConfPath: string | null = null;

const SUBDOMAIN_POLL_INTERVAL_MS = 5 * 60_000;

// --- Tunnel health watchdog（隧道自愈） ---
//
// frpc does NOT retry a proxy whose NewProxy registration the relay rejected — it only
// re-registers on a fresh connection. So when the grant gate denies an unpaid gateway and the
// user later pays（出门在外付费开通）, the tunnel would stay down until a manual gateway restart.
// This watchdog probes our own public URL end-to-end (gateway → frps → back); after
// `TUNNEL_HEALTH_STRIKES` consecutive failures it kills frpc, and the 3s keepalive respawn
// re-issues NewProxy — a freshly-granted tunnel comes up within ~STRIKES·INTERVAL of payment.
// Steady-state cost: one HTTPS HEAD per minute; a permanently-denied gateway retries NewProxy
// once every ~3 minutes (bounded relay load).
const TUNNEL_HEALTH_INTERVAL_MS = 60_000;
const TUNNEL_HEALTH_STRIKES = 3;

/** Consecutive-failure counter for the tunnel watchdog. `note(ok)` returns true when the
 * caller should restart the tunnel (counter resets so the next window starts clean). */
export class TunnelHealthTracker {
  private strikes = 0;
  constructor(private readonly strikesToRestart: number = TUNNEL_HEALTH_STRIKES) {}
  get consecutiveFailures(): number {
    return this.strikes;
  }
  note(ok: boolean): boolean {
    if (ok) {
      this.strikes = 0;
      return false;
    }
    this.strikes += 1;
    if (this.strikes >= this.strikesToRestart) {
      this.strikes = 0;
      return true;
    }
    return false;
  }
}

/** Reachability probe through the public relay. ANY HTTP response means the tunnel is up
 * (401/403/404 all prove frps routed us home); only transport errors/timeouts count as down.
 * Cert validation is off — reachability is the question here, and the app does real pinning. */
function probeTunnelHealth(publicUrl: string, timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    try {
      const req = httpsRequest(
        `${publicUrl}/friday-next/health`,
        { method: "HEAD", rejectUnauthorized: false, timeout: timeoutMs },
        (res) => {
          res.resume();
          done(true);
        },
      );
      req.on("timeout", () => {
        req.destroy();
        done(false);
      });
      req.on("error", () => done(false));
      req.end();
    } catch {
      done(false);
    }
  });
}

/** After this many watchdog-issued restarts with no healthy probe in between, assume the
 * problem is our REGISTRATION, not a transient outage (e.g. the relay registry was rebuilt
 * and no longer maps our locally-persisted subdomain — NewProxy is denied forever). The
 * escalation discards the local allocation and re-runs bring-up so a fresh allocation can
 * self-heal what no amount of frpc restarts ever would. */
const TUNNEL_RESTART_CYCLES_BEFORE_REALLOC = 5;

/** One watchdog per process; idempotent. Skips probing while frpc itself is down (the
 * keepalive owns that window) and while a probe would race a just-issued restart. */
function startTunnelHealthWatchdog(publicUrl: string, cfg: PublicAccessConfig, log: Logger): void {
  if (healthTimer) return;
  const tracker = new TunnelHealthTracker();
  let restartCycles = 0;
  const timer = setInterval(() => {
    if (stopped || !child) return;
    void probeTunnelHealth(publicUrl).then((ok) => {
      if (stopped || !child) return;
      if (ok) {
        restartCycles = 0;
      }
      if (tracker.note(ok)) {
        restartCycles += 1;
        if (restartCycles >= TUNNEL_RESTART_CYCLES_BEFORE_REALLOC && !cfg.subdomain?.trim()) {
          log(
            `tunnel health: ${restartCycles} restart cycles without recovery — discarding local ` +
              `subdomain allocation and re-running bring-up (relay registry may have been rebuilt)`,
          );
          discardLocalSubdomainAllocation();
          stopPublicAccess();
          void startPublicAccess(cfg, log);
          return;
        }
        log(
          `tunnel health: ${publicUrl} unreachable ${TUNNEL_HEALTH_STRIKES}x — restarting frpc to re-issue NewProxy`,
        );
        try {
          child.kill(); // exit handler respawns via keepalive
        } catch {
          /* already gone — keepalive covers it */
        }
      } else if (!ok) {
        log(`tunnel health: probe failed (${tracker.consecutiveFailures}/${TUNNEL_HEALTH_STRIKES})`);
      }
    });
  }, TUNNEL_HEALTH_INTERVAL_MS);
  timer.unref?.();
  healthTimer = timer;
}

function ensureDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}

function frpcPath(): string {
  return join(DATA_DIR, "frpc");
}

function getLanIp(): string {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

const execFileAsync = promisify(execFile);

function frpcVersionPath(): string {
  return join(DATA_DIR, "frpc.version");
}

/**
 * Download + checksum-verify + extract the frpc binary for this platform. A version marker
 * file makes `FRP_VERSION` bumps actually reach existing installs (a bare `existsSync` check
 * would pin old users to the first binary forever — frp security fixes could never ship).
 * The download is async so a slow GitHub fetch can't block the gateway's event loop.
 */
async function ensureBinary(log: Logger): Promise<void> {
  const p = frpcPath();
  const installed = existsSync(frpcVersionPath())
    ? readFileSync(frpcVersionPath(), "utf8").trim()
    : "";
  if (existsSync(p) && installed === FRP_VERSION) return;
  ensureDir();
  const plat = platform() === "darwin" ? "darwin" : "linux";
  const a = arch() === "arm64" ? "arm64" : "amd64";
  const base = `frp_${FRP_VERSION}_${plat}_${a}`;
  const rel = `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}`;
  const tgz = join(DATA_DIR, "frp.tgz");
  log(`downloading frpc ${base} …`);
  await execFileAsync("curl", ["-fsSL", "-o", tgz, `${rel}/${base}.tar.gz`], { timeout: 180_000 });

  // Supply-chain: verify against the release's published sha256 checksums.
  const sums = (
    await execFileAsync("curl", ["-fsSL", `${rel}/frp_sha256_checksums.txt`], { timeout: 60_000 })
  ).stdout.toString();
  const want = sums
    .split("\n")
    .find((l) => l.includes(`${base}.tar.gz`))
    ?.trim()
    .split(/\s+/)[0];
  const got = createHash("sha256").update(readFileSync(tgz)).digest("hex");
  if (!want || want.toLowerCase() !== got.toLowerCase()) {
    throw new Error(`frpc checksum mismatch: want=${want ?? "(none)"} got=${got}`);
  }
  execFileSync("tar", ["xzf", tgz, "-C", DATA_DIR, "--strip-components=1", `${base}/frpc`], {
    timeout: 60_000,
  });
  chmodSync(p, 0o755);
  writeFileSync(frpcVersionPath(), FRP_VERSION);
  log(`frpc ${FRP_VERSION} installed (checksum ok)${installed ? ` — upgraded from ${installed}` : ""}`);
}

/** The one gateway keypair, shared by every cert (base LE cert + all per-Apple-ID self-signed
 * leaves). The app pins the public KEY, so reusing it means one pin covers every subdomain and
 * a real→self-signed fallback never invalidates it. Created once. */
function ensureGatewayKey(): string {
  ensureDir();
  const key = join(DATA_DIR, "gateway-key.pem");
  if (!existsSync(key)) {
    execFileSync("openssl", ["genrsa", "-out", key, "2048"], { timeout: 30_000 });
    chmodSync(key, 0o600); // TLS private key — owner-only, same discipline as attest-store
  }
  return key;
}

/** Persisted self-signed leaf for `cn` + its SHA-256 fingerprint (lowercase hex, no colons).
 * `crtName` lets each per-Apple-ID subdomain keep its own cert file off the shared key. */
function ensureCert(cn: string, crtName = "gateway-cert.pem"): { crt: string; key: string; fingerprint: string } {
  const key = ensureGatewayKey();
  const crt = join(DATA_DIR, crtName);
  if (!existsSync(crt)) {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-key", key, "-out", crt,
        "-days", "3650", "-nodes", "-subj", `/CN=${cn}`,
      ],
      { timeout: 30_000 },
    );
  }
  return { crt, key, fingerprint: leafFingerprint(crt) };
}

/** Per-Apple-ID subdomain cert filename (distinct file, shared key). */
function certNameForSub(sub: string): string {
  return `sub-${sub}.pem`;
}

/** Leaf SHA-256 fingerprint of a PEM cert/fullchain (lowercase hex, no colons). */
function leafFingerprint(crtPath: string): string {
  return execFileSync("openssl", ["x509", "-in", crtPath, "-noout", "-fingerprint", "-sha256"])
    .toString()
    .split("=")[1]
    .replace(/:/g, "")
    .trim()
    .toLowerCase();
}

/** True when the cert is missing or expires within 30 days (needs (re)issue). */
function certNeedsRenewal(crtPath: string): boolean {
  if (!existsSync(crtPath)) return true;
  try {
    const out = execFileSync("openssl", ["x509", "-in", crtPath, "-noout", "-enddate"]).toString();
    const m = out.match(/notAfter=(.+)/);
    if (!m) return true;
    return new Date(m[1].trim()).getTime() - Date.now() < 30 * 24 * 3600 * 1000;
  } catch {
    return true;
  }
}

/** POST the CSR to the relay cert-signer; returns the LE fullchain PEM or throws. */
async function requestSignedCert(
  url: string,
  token: string,
  keyHash: string,
  csrPem: string,
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ key: keyHash, csr: csrPem }),
    signal: AbortSignal.timeout(130_000),
  });
  if (!res.ok) throw new Error(`cert-sign HTTP ${res.status}`);
  const data = (await res.json()) as { fullchain?: unknown };
  const fc = typeof data.fullchain === "string" ? data.fullchain : "";
  if (!fc.includes("BEGIN CERTIFICATE")) throw new Error("cert-sign returned no fullchain");
  return fc;
}

/**
 * Ensure a browser-trusted cert for `cn`: the gateway generates its own keypair,
 * sends only a CSR to the relay signer, and receives a real Let's Encrypt fullchain
 * (private key never leaves this host → relay still can't decrypt). Reuses a valid
 * cert; falls back to a self-signed cert if signing fails, so public access still
 * works (the app pins the leaf either way; only browsers see the self-signed warning).
 */
async function ensureRealCert(
  cfg: PublicAccessConfig,
  cn: string,
  log: Logger,
): Promise<{ crt: string; key: string; fingerprint: string }> {
  ensureDir();
  const key = join(DATA_DIR, "gateway-key.pem");
  const crt = join(DATA_DIR, "gateway-fullchain.pem");
  if (existsSync(key) && !certNeedsRenewal(crt)) {
    return { crt, key, fingerprint: leafFingerprint(crt) };
  }
  try {
    if (!existsSync(key)) {
      execFileSync("openssl", ["genrsa", "-out", key, "2048"]);
      chmodSync(key, 0o600); // TLS private key — owner-only
    }
    const csrPath = join(DATA_DIR, "gateway.csr");
    execFileSync("openssl", ["req", "-new", "-key", key, "-out", csrPath, "-subj", `/CN=${cn}`]);
    const keyHash = createHash("sha256").update(cfg.authToken || "").digest("hex");
    const fullchain = await requestSignedCert(
      cfg.certSignUrl,
      cfg.relayToken,
      keyHash,
      readFileSync(csrPath, "utf8"),
    );
    writeFileSync(crt, fullchain);
    log(`obtained Let's Encrypt cert for ${cn}`);
    return { crt, key, fingerprint: leafFingerprint(crt) };
  } catch (e) {
    log(`real cert failed (${e instanceof Error ? e.message : String(e)}); using self-signed`);
    return ensureCert(cn); // app still works via leaf pinning; browsers warn
  }
}

/** POST the gateway key to the relay allocator; returns the assigned subdomain or throws. */
async function requestAllocation(url: string, token: string, key: string): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ key }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`allocator HTTP ${res.status}`);
  const data = (await res.json()) as { subdomain?: unknown };
  const sub = typeof data.subdomain === "string" ? data.subdomain.trim() : "";
  if (!sub) throw new Error("allocator returned no subdomain");
  return sub;
}

function subdomainPath(): string {
  return join(DATA_DIR, "subdomain.txt");
}
function subdomainKeyPath(): string {
  return join(DATA_DIR, "subdomain.key");
}

/** Drop the locally-persisted allocation so the next bring-up re-asks the relay registry.
 * Used when the local record can no longer be trusted (gateway key changed, or the relay
 * keeps rejecting our registration — e.g. its registry was rebuilt without us). */
export function discardLocalSubdomainAllocation(): void {
  try {
    rmSync(subdomainPath(), { force: true });
    rmSync(subdomainKeyPath(), { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Resolve this gateway's subdomain, collision-proof by construction:
 *   1. explicit `cfg.subdomain` override, else
 *   2. the locally-persisted allocation (`subdomain.txt`) — honored only while the gateway
 *      key it was allocated under (`subdomain.key`) still matches, so rotating `authToken`
 *      re-allocates instead of silently reusing a record the registry no longer maps to, else
 *   3. a fresh allocation from the relay registry keyed by sha256(authToken).
 * Returns null when step 3 can't reach the relay — the caller then BLOCKS public
 * access rather than minting a locally-random subdomain (which could collide).
 */
async function resolveSubdomain(cfg: PublicAccessConfig, log: Logger): Promise<string | null> {
  if (cfg.subdomain && cfg.subdomain.trim()) return cfg.subdomain.trim();
  const key = createHash("sha256").update(cfg.authToken || "").digest("hex");
  const f = subdomainPath();
  if (existsSync(f)) {
    const s = readFileSync(f, "utf8").trim();
    const allocKey = existsSync(subdomainKeyPath())
      ? readFileSync(subdomainKeyPath(), "utf8").trim()
      : ""; // pre-key-file installs: keep the record and stamp the current key below
    if (s && (!allocKey || allocKey === key)) {
      if (!allocKey) writeFileSync(subdomainKeyPath(), key);
      return s;
    }
    if (s) log(`gateway key changed — discarding stale subdomain allocation "${s}"`);
    discardLocalSubdomainAllocation();
  }
  ensureDir();
  try {
    const sub = await requestAllocation(cfg.allocatorUrl, cfg.relayToken, key);
    writeFileSync(f, sub);
    writeFileSync(subdomainKeyPath(), key);
    log(`allocated subdomain "${sub}" from relay registry`);
    return sub;
  } catch (e) {
    log(`subdomain allocation failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Write our OWN frpc config into the plugin-private data dir — never the user's frpc.toml.
 * Isolation from a user's own frp on the same host is structural:
 *   • Deliberately NO `webServer.port` — enabling frpc's admin server (default 7400) is the
 *     one thing that would collide with a user's own frpc. We manage our child by PID
 *     (killOrphanFrpc), so the admin server is unnecessary as well as risky. Never add it.
 *   • Proxy `name` is namespaced (`friday-next-public`) so it can't clash on the shared relay.
 *   • `https2http` forwards into our filter proxy on 127.0.0.1 — no new public listen port.
 */
/** A subdomain to expose + the cert/key frpc terminates its TLS with (all share the one key). */
type ProxySpec = { subdomain: string; crt: string; key: string };

/**
 * Write our frpc config with ONE https2http proxy per subdomain (D31: the base subdomain plus
 * one per additional authorized Apple ID, each its own `*.subDomainHost` hostname routed by SNI
 * to the same local filter port). Proxy names are namespaced + subdomain-suffixed so they never
 * clash on the shared relay. Returns the config path.
 */
function writeFrpcConfig(cfg: PublicAccessConfig, proxies: ProxySpec[]): string {
  const [host, portRaw] = cfg.relayAddr.split(":");
  const port = Number(portRaw) || 7000;
  const head = `serverAddr = "${host}"
serverPort = ${port}
auth.token = "${cfg.relayToken}"
log.to = "${join(DATA_DIR, "frpc.log")}"
log.level = "info"
log.maxDays = 3
`;
  const blocks = proxies
    .map(
      (px) => `
[[proxies]]
name = "friday-next-public-${px.subdomain}"
type = "https"
subdomain = "${px.subdomain}"
[proxies.plugin]
type = "https2http"
localAddr = "127.0.0.1:${filterPort(cfg.corePort)}"
crtPath = "${px.crt}"
keyPath = "${px.key}"
`,
    )
    .join("");
  const p = join(DATA_DIR, "frpc.toml");
  writeFileSync(p, head + blocks, { mode: 0o600 }); // contains the shared relay token — owner-only
  chmodSync(p, 0o600); // mode above only applies on create; tighten pre-existing files too
  return p;
}

/** Resolve the ProxySpec set for a subdomain list: the BASE subdomain uses the (LE-or-self-signed)
 * primary cert; every additional per-Apple-ID subdomain gets its own self-signed leaf off the
 * shared key. `baseSub`/`baseCrt`/`baseKey` are the already-ensured primary. */
function proxySpecsFor(
  subdomains: string[],
  baseSub: string,
  baseCrt: string,
  baseKey: string,
  subDomainHost: string,
): ProxySpec[] {
  const specs: ProxySpec[] = [];
  const seen = new Set<string>();
  for (const sub of subdomains) {
    if (!sub || seen.has(sub)) continue;
    seen.add(sub);
    if (sub === baseSub) {
      specs.push({ subdomain: sub, crt: baseCrt, key: baseKey });
    } else {
      const { crt, key } = ensureCert(`${sub}.${subDomainHost}`, certNameForSub(sub));
      specs.push({ subdomain: sub, crt, key });
    }
  }
  if (!seen.has(baseSub)) specs.unshift({ subdomain: baseSub, crt: baseCrt, key: baseKey });
  return specs;
}

function frpcPidPath(): string {
  return join(DATA_DIR, "frpc.pid");
}

/** Read a live process's command line for identity verification. Prefers Linux `/proc`
 * (zero external deps), falls back to `ps` on macOS. Returns null if the pid isn't alive
 * (or can't be read) — the caller then reaps nothing, which is the safe outcome. */
function processCmdline(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replace(/\0/g, " ");
  } catch {
    /* not Linux, or pid gone — try ps */
  }
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { timeout: 5_000 }).toString();
  } catch {
    return null;
  }
}

/**
 * Reap ONLY our own orphan frpc left by a prior gateway process (crash/restart before
 * stopPublicAccess ran). Isolation from a user's own frp is by construction — we never
 * match on the process name `frpc`, only:
 *   1. the exact PID we recorded in `frpc.pid` on spawn, AND
 *   2. a verification that this live PID's command line still references OUR unique config
 *      path (guards against the PID having been reused by an unrelated process).
 * If either check doesn't line up we reap nothing — we would rather leak one stale frpc
 * than ever risk SIGTERM-ing someone else's process. Called ONCE at start, never in the
 * respawn path (which manages the live `child` reference directly).
 */
function killOrphanFrpc(confPath: string, log: Logger): void {
  let pid = 0;
  try {
    pid = Number(readFileSync(frpcPidPath(), "utf8").trim()) || 0;
  } catch {
    return; // no pidfile → nothing we started is orphaned
  }
  if (!pid || pid === child?.pid) return;
  const cmd = processCmdline(pid);
  if (!cmd || !cmd.includes(confPath)) return; // dead, or PID reused by something not ours
  try {
    process.kill(pid, "SIGTERM");
    log(`reaped orphan frpc pid=${pid}`);
  } catch {
    /* already gone */
  }
}

const RESPAWN_BASE_MS = 3000;
const RESPAWN_MAX_MS = 60_000;
let respawnDelayMs = RESPAWN_BASE_MS;

function scheduleRespawn(confPath: string, log: Logger): void {
  if (keepaliveTimer) clearTimeout(keepaliveTimer);
  keepaliveTimer = setTimeout(() => {
    keepaliveTimer = null;
    if (!stopped && !child) spawnFrpc(confPath, log);
  }, respawnDelayMs);
}

function spawnFrpc(confPath: string, log: Logger): void {
  const startedAt = Date.now();
  const bumpBackoff = (): void => {
    // A child that lived >60s was healthy — restart fresh; rapid deaths back off
    // exponentially so a broken binary/config doesn't hot-loop every 3s forever.
    respawnDelayMs =
      Date.now() - startedAt > 60_000
        ? RESPAWN_BASE_MS
        : Math.min(respawnDelayMs * 2, RESPAWN_MAX_MS);
  };
  const c = spawn(frpcPath(), ["-c", confPath], { stdio: "ignore", detached: false });
  child = c;
  if (c.pid) {
    try {
      writeFileSync(frpcPidPath(), String(c.pid));
    } catch {
      /* best-effort — orphan reap simply no-ops without a pidfile */
    }
  }
  // A ChildProcess with no `error` listener throws uncaughtException on spawn failure
  // (binary deleted → ENOENT on a keepalive respawn, EPERM, …) — which would take down
  // the ENTIRE host gateway process for an accessory feature. Handle it like an exit.
  c.on("error", (err) => {
    if (child !== c) return;
    child = null;
    if (stopped) return;
    bumpBackoff();
    log(`frpc spawn error (${err.message}); retrying in ${Math.round(respawnDelayMs / 1000)}s`);
    scheduleRespawn(confPath, log);
  });
  c.on("exit", (code) => {
    if (child !== c) return; // superseded by a newer child — ignore this stale exit
    child = null;
    if (stopped) return;
    bumpBackoff();
    log(`frpc exited (code=${code ?? "null"}); respawning in ${Math.round(respawnDelayMs / 1000)}s`);
    scheduleRespawn(confPath, log);
  });
}

/** Schedule a full bring-up retry (transient failures: relay unreachable, GitHub download
 * down, …) — one pending retry at a time, cancelled by stopPublicAccess. */
function scheduleBringUpRetry(cfg: PublicAccessConfig, log: Logger): void {
  if (allocRetryTimer) clearTimeout(allocRetryTimer);
  if (stopped) return;
  allocRetryTimer = setTimeout(() => {
    allocRetryTimer = null;
    if (!stopped && !child) void startPublicAccess(cfg, log);
  }, 30_000);
}

/** Daily check: renew the LE cert before it lapses on a long-running gateway (it only used to
 * be checked at startup — 90-day certs expired under gateways that never restart), then respawn
 * frpc so the LIVE tunnel actually serves the renewed cert and refresh the cached pairing so
 * QR fingerprints match reality. */
function startCertRenewalTimer(cfg: PublicAccessConfig, cn: string, log: Logger): void {
  if (certRenewalTimer) return;
  const timer = setInterval(() => {
    if (stopped) return;
    if (!certNeedsRenewal(join(DATA_DIR, "gateway-fullchain.pem"))) return;
    log("cert renewal window reached — re-issuing and restarting frpc");
    void (async () => {
      try {
        const { crt, key, fingerprint } = await ensureRealCert(cfg, cn, log);
        if (baseTunnel) baseTunnel = { ...baseTunnel, crt, key };
        rewriteConfigForServed(cfg);
        if (cachedPairing) cachedPairing = { ...cachedPairing, fingerprint };
        if (child) child.kill(); // keepalive respawns with the fresh config/cert
      } catch (e) {
        log(`cert renewal failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }, 24 * 3600 * 1000);
  timer.unref?.();
  certRenewalTimer = timer;
}

/** Bring public access up. Returns the pairing info (also cached for the HTTP endpoint). */
export async function startPublicAccess(
  cfg: PublicAccessConfig,
  log: Logger,
): Promise<PairingInfo | null> {
  if (!cfg.enabled) {
    // "Disabled" must mean NOT PUBLICLY REACHABLE — tear down whatever a previous enable
    // left behind (live frpc, filter proxy, watchdogs, cached pairing), and reap an orphan
    // frpc from a prior gateway process too: the old early-return skipped killOrphanFrpc,
    // so flipping the config off and restarting left the tunnel serving forever.
    const wasRunning = child != null || filterServer != null || cachedPairing != null;
    stopPublicAccess();
    killOrphanFrpc(join(DATA_DIR, "frpc.toml"), log);
    log(
      `public access disabled (channels.friday-next.publicAccess.enabled=false)` +
        (wasRunning ? " — tore down running tunnel" : ""),
    );
    return null;
  }
  stopped = false;
  try {
    ensureDir();
    await ensureBinary(log);
  } catch (e) {
    log(
      `public access bring-up failed (${e instanceof Error ? e.message : String(e)}) — retrying in 30s`,
    );
    scheduleBringUpRetry(cfg, log);
    return null;
  }

  // Public-surface allowlist: frpc forwards into this filter (not core directly), so the
  // tunnel exposes only the app's paths — never core's /chat, /control, or / web UI.
  if (!filterServer) {
    filterServer = startFilterProxy(filterPort(cfg.corePort), cfg.corePort, log);
  }

  // Block (don't tunnel) until the relay hands us a collision-proof subdomain; retry
  // so a transient relay outage self-heals without minting a risky local subdomain.
  const subdomain = await resolveSubdomain(cfg, log);
  if (!subdomain) {
    log("public access blocked: no subdomain allocated (relay unreachable?) — retrying in 30s");
    scheduleBringUpRetry(cfg, log);
    return null;
  }
  const cn = `${subdomain}.${cfg.subDomainHost}`;
  const { crt, key, fingerprint } = await ensureRealCert(cfg, cn, log);
  baseTunnel = { sub: subdomain, crt, key, cn };
  // Preserve any already-known per-Apple-ID subdomains across a re-register (the poll refreshes
  // them); start from just the base if this is a cold bring-up.
  if (!servedSubdomains.includes(subdomain)) servedSubdomains = [subdomain, ...servedSubdomains];
  const confPath = rewriteConfigForServed(cfg);

  cachedPairing = {
    v: 2, // superset schema with a one-time pairing voucher minted per fetch (D12)
    lanUrl: `http://${getLanIp()}:${cfg.corePort}`,
    publicUrl: `https://${cn}`,
    fingerprint,
    token: cfg.authToken,
    subdomain,
  };

  // Idempotent: a duplicate registerFull must NOT respawn a live tunnel (that caused
  // flapping) — but the pairing info is still rebuilt above so the endpoint never serves
  // a stale fingerprint/lanUrl from before a cert renewal or address change.
  if (child && child.exitCode === null && !child.killed) {
    log("public access already running — refreshed config/pairing, keeping current frpc");
    startTunnelHealthWatchdog(`https://${cn}`, cfg, log);
    startCertRenewalTimer(cfg, cn, log);
    startGatewaySubdomainPoll(cfg, log);
    return cachedPairing;
  }
  killOrphanFrpc(confPath, log); // clear a stale frpc from a prior gateway process, once
  spawnFrpc(confPath, log);
  startTunnelHealthWatchdog(`https://${cn}`, cfg, log);
  startCertRenewalTimer(cfg, cn, log);
  startGatewaySubdomainPoll(cfg, log);

  log(`public access up → ${cachedPairing.publicUrl} (fp ${fingerprint.slice(0, 16)}…)`);
  return cachedPairing;
}

/** (Re)write frpc.toml for the current `servedSubdomains` set off `baseTunnel`. Returns the path. */
function rewriteConfigForServed(cfg: PublicAccessConfig): string {
  if (!baseTunnel) throw new Error("rewriteConfigForServed before baseTunnel set");
  const specs = proxySpecsFor(
    servedSubdomains,
    baseTunnel.sub,
    baseTunnel.crt,
    baseTunnel.key,
    cfg.subDomainHost,
  );
  spawnConfPath = writeFrpcConfig(cfg, specs);
  return spawnConfPath;
}

/**
 * Reconcile the served subdomain set against `desired` (from the control-plane poll). On a real
 * change, rewrite frpc.toml and restart frpc so the new per-Apple-ID proxies register (and dropped
 * ones stop). The base subdomain is always retained so the owner's tunnel never disappears.
 */
export function reconcileServedSubdomains(cfg: PublicAccessConfig, desired: string[], log: Logger): boolean {
  if (!baseTunnel) return false;
  const next = Array.from(new Set([baseTunnel.sub, ...desired.filter(Boolean)])).sort();
  const cur = Array.from(new Set(servedSubdomains)).sort();
  if (next.length === cur.length && next.every((s, i) => s === cur[i])) return false;
  const added = next.filter((s) => !cur.includes(s));
  const removed = cur.filter((s) => !next.includes(s));
  servedSubdomains = next;
  rewriteConfigForServed(cfg);
  log(`served subdomains changed (+${added.length}/-${removed.length}) — restarting frpc to re-register`);
  if (child) child.kill(); // keepalive respawns from the rewritten config
  return true;
}

/** Poll the control plane for the per-Apple-ID subdomains this gateway should serve (D31), and
 * reconcile the frpc proxy set. Idempotent; one timer per process. Best-effort — a control-plane
 * outage just leaves the current set running. */
function startGatewaySubdomainPoll(cfg: PublicAccessConfig, log: Logger): void {
  if (subdomainPollTimer) return;
  const gatewayKey = createHash("sha256").update(cfg.authToken || "").digest("hex");
  const url = `${cfg.controlPlaneUrl.replace(/\/$/, "")}/v1/gateway/subdomains`;
  const poll = async (): Promise<void> => {
    if (stopped) return;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gatewayKey }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { subdomains?: unknown };
      const subs = Array.isArray(data.subdomains)
        ? data.subdomains.filter((s): s is string => typeof s === "string")
        : [];
      reconcileServedSubdomains(cfg, subs, log);
    } catch {
      /* control plane unreachable — keep current set */
    }
  };
  const timer = setInterval(() => void poll(), SUBDOMAIN_POLL_INTERVAL_MS);
  timer.unref?.();
  subdomainPollTimer = timer;
  void poll(); // fire once now so a newly-granted Apple ID comes up within seconds, not 5 min
}

export function stopPublicAccess(): void {
  stopped = true;
  cachedPairing = null; // pairing endpoint must go 503, not serve a dead tunnel's info
  if (keepaliveTimer) {
    clearTimeout(keepaliveTimer);
    keepaliveTimer = null;
  }
  if (allocRetryTimer) {
    clearTimeout(allocRetryTimer);
    allocRetryTimer = null;
  }
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  if (certRenewalTimer) {
    clearInterval(certRenewalTimer);
    certRenewalTimer = null;
  }
  if (subdomainPollTimer) {
    clearInterval(subdomainPollTimer);
    subdomainPollTimer = null;
  }
  baseTunnel = null;
  servedSubdomains = [];
  spawnConfPath = null;
  if (child) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    child = null;
  }
  if (filterServer) {
    try {
      filterServer.close();
    } catch {
      /* ignore */
    }
    filterServer = null;
  }
}

/** Test/introspection: the subdomains currently written into frpc.toml. */
export function currentServedSubdomains(): string[] {
  return [...servedSubdomains];
}

export function getPairingInfo(): PairingInfo | null {
  return cachedPairing;
}
