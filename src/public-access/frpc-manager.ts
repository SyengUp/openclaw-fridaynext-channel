/**
 * Public access (FridayNext 云) — frpc tunnel manager.
 *
 * Makes the local OpenClaw gateway reachable from the public internet through the relay, WITHOUT
 * the relay ever decrypting: frpc terminates TLS locally with a self-signed cert (the `https2http`
 * plugin) and forwards plain HTTP to core `:corePort`; the relay's frps does SNI passthrough only.
 * The app pins the self-signed leaf fingerprint (delivered in the pairing QR superset), so the
 * TLS is end-to-end to this machine.
 *
 * Lifecycle: `startPublicAccess()` always enters a low-traffic control-plane standby after
 * allocating a stable identity and certificate. It deliberately does NOT download/spawn frpc
 * until the control plane returns at least one entitled subdomain. Returning to an empty desired
 * set tears the tunnel down while keeping standby alive. `stopPublicAccess()` is the hidden
 * operator hard stop. All state lives under `~/.openclaw/friday-next/public-access/`.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createSocket } from "node:dgram";
import { request as httpsRequest } from "node:https";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
  renameSync,
} from "node:fs";
import { promisify } from "node:util";
import { createHash, createPublicKey } from "node:crypto";
import { homedir, platform, arch, networkInterfaces } from "node:os";
import { join } from "node:path";
import { startTunnelEdge, type TunnelBackend, type TunnelEdge } from "@fridaynext/tunnel-edge";
import { verifySession } from "../attest/attest-store.js";
import { resolveFridayNextConfig } from "../config.js";
import { getHostOpenClawConfigSnapshot } from "../host-config.js";
import { StandbyLoopGuard } from "./standby-loop-guard.js";
import { TunnelWatchdogPolicy } from "./tunnel-watchdog-policy.js";
import { getFridayNextRuntime } from "../runtime.js";

const FRP_VERSION = "0.69.1";
const FRP_SHA256: Record<string, string> = {
  "frp_0.69.1_darwin_amd64": "2bc26d02100ef333f2712149ea5997dc530dc0eefac64f4be41cb0f49d032f40",
  "frp_0.69.1_darwin_arm64": "310012e2f1dcf3cdde2605d29b95340b686c94d1680a23711d58efeffc02f64e",
  "frp_0.69.1_linux_amd64": "7be257b72dbbc60bcb3e0e25a5afd1dfac7b63f897084864d3c956dd3d5674e1",
  "frp_0.69.1_linux_arm64": "bbc0c75e896af3f292fb46ba09c844a04fa9b5ea3530c039c7af20637f836355",
};

export function expectedFrpcArchiveSHA256(base: string): string | null {
  return FRP_SHA256[base] ?? null;
}

export function frpcDownloadSources(controlPlaneUrl: string, base: string): string[] {
  const controlPlaneBase = controlPlaneUrl.replace(/\/+$/, "");
  return [
    `${controlPlaneBase}/v1/frpc/v${FRP_VERSION}/${base}.tar.gz`,
    `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${base}.tar.gz`,
  ];
}
// Override is primarily for hermetic tests and managed deployments. Production defaults to the
// plugin-private OpenClaw directory; never share this with a user's own frp installation.
const DATA_DIR =
  process.env.FRIDAY_NEXT_PUBLIC_ACCESS_DATA_DIR?.trim() ||
  join(homedir(), ".openclaw", "friday-next", "public-access");

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
  /** Conductor HTTP port to expose through the same tunnel as `/cap/*`.
   * 0/unset disables the conductor backend. Precedence is documented on
   * `resolveConductorPort`. */
  conductorPort?: number;
  /** Conductor upstream host (default 127.0.0.1; another trusted LAN host when the
   * conductor runs on a different machine than this gateway). */
  conductorHost?: string;
  /** Bearer token the app uses (from the channel config). */
  authToken: string;
  /** Relay region this gateway is routed to (from `/v1/relay/bootstrap`; e.g. "bj"/"na").
   * Informational only — the DNS for `subDomainHost` is what actually routes traffic. */
  region?: string;
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
let filterServer: TunnelEdge | null = null;
let stopped = false;

/** Local port of the public-surface filter proxy that frpc forwards into (core + 1). */
function filterPort(corePort: number): number {
  return corePort + 1;
}

/** Resolve the conductor backend port for the public edge routing table.
 *
 * Precedence:
 *   1. explicit `PublicAccessConfig.conductorPort` (caller override)
 *   2. `FRIDAY_NEXT_CONDUCTOR_PORT` env (positive integer)
 *   3. plugin config `channels["friday-next"].publicAccess.conductorPort`
 *
 * 0/unset disables the conductor backend. The plugin config is resolved from the live runtime
 * snapshot so a config hot-reload can add/remove the `/cap` backend without a process restart.
 */
export function resolveConductorPort(cfg: PublicAccessConfig): number {
  const fromExplicit = positivePort(cfg.conductorPort);
  if (fromExplicit !== 0) return fromExplicit;
  const fromEnv = positivePort(Number(process.env.FRIDAY_NEXT_CONDUCTOR_PORT));
  if (fromEnv !== 0) return fromEnv;
  return positivePort(
    resolveFridayNextConfig(getHostOpenClawConfigSnapshot(getFridayNextRuntime().config))
      .publicAccess.conductorPort,
  );
}

/** Resolve the conductor upstream host for the edge routing table.
 *
 * Precedence:
 *   1. explicit `PublicAccessConfig.conductorHost`
 *   2. `FRIDAY_NEXT_CONDUCTOR_HOST` env
 *   3. plugin config `channels["friday-next"].publicAccess.conductorHost`
 *
 * Defaults to 127.0.0.1 (conductor and gateway on the same host).
 */
export function resolveConductorHost(cfg: PublicAccessConfig): string {
  const candidates = [
    cfg.conductorHost,
    process.env.FRIDAY_NEXT_CONDUCTOR_HOST,
    resolveFridayNextConfig(getHostOpenClawConfigSnapshot(getFridayNextRuntime().config))
      .publicAccess.conductorHost,
  ];
  for (const candidate of candidates) {
    const host = typeof candidate === "string" ? candidate.trim() : "";
    if (host && !host.includes("://") && !host.includes("/")) return host;
  }
  return "127.0.0.1";
}

function positivePort(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 0;
}
let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
let allocRetryTimer: ReturnType<typeof setTimeout> | null = null;
let cachedPairing: PairingInfo | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let certRenewalTimer: ReturnType<typeof setInterval> | null = null;
let subdomainPollTimer: ReturnType<typeof setTimeout> | null = null;
// D31: the gateway's base tunnel (from resolveSubdomain) + the full set of subdomains currently
// written into frpc.toml (base + per-Apple-ID). The poll reconciles the set against the control
// plane; `spawnConfPath` is what the keepalive respawns from.
let baseTunnel: { sub: string; crt: string; key: string; cn: string } | null = null;
let servedSubdomains: string[] = [];
let spawnConfPath: string | null = null;
let standbyRevision = "";
/// standby 长轮询的生命周期闸门（代际号）：stop→start 不再叠出重复轮询。
const standbyLoop = new StandbyLoopGuard();
let tunnelTransition: Promise<void> = Promise.resolve();

// The standby request is held by the control plane for up to 25 seconds and wakes immediately
// when a grant changes (Telegram-style long polling). A short delay is used only after a response;
// failures back off separately so an outage cannot create a hot loop.
const STANDBY_WAIT_SEC = 25;
const STANDBY_NEXT_POLL_MS = 250;
const STANDBY_ERROR_RETRY_MS = 5_000;

// --- Tunnel health watchdog（隧道自愈） ---
//
// frpc does NOT retry a proxy whose NewProxy registration the relay rejected — it only
// re-registers on a fresh connection. So when the grant gate denies an unpaid gateway and the
// user later pays（出门在外付费开通）, the tunnel would stay down until a manual gateway restart.
// This watchdog probes our own public URL end-to-end (gateway → frps → back); after
// `TUNNEL_HEALTH_STRIKES` consecutive failures it kills frpc, and the 3s keepalive respawn
// re-issues NewProxy — a freshly-granted tunnel comes up within ~STRIKES·INTERVAL of payment.
// Steady-state cost: one HTTPS HEAD per minute; a permanently-denied gateway retries NewProxy
// once every ~3 minutes, then backs off exponentially to once per 30 minutes (see
// `TunnelWatchdogPolicy`) so a policy-denied gateway cannot storm the relay gate forever.
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

/** Statuses that prove the request reached THIS gateway's core: a live plugin answers 200 (or a
 * redirect), and 401/403 mean it answered before auth. Deliberately NOT "any HTTP response":
 * frpc itself replies with a 5xx when it cannot reach the local filter port, and the relay edge
 * serves 404 for a vhost that is no longer registered — counting those as healthy is exactly how
 * a broken tunnel stayed broken forever (the watchdog never fired). Mirrors the app-side probe. */
export function isTunnelHealthyStatus(status: number | undefined): boolean {
  if (!status) return false;
  return (status >= 200 && status < 400) || status === 401 || status === 403;
}

/** Reachability probe through the public relay (gateway → frps → back into our filter port).
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
          done(isTunnelHealthyStatus(res.statusCode));
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
 * self-heal what no amount of frpc restarts ever would. The escalation LADDER (restart →
 * backoff → realloc with cooldown) lives in `TunnelWatchdogPolicy`, kept pure for tests. */

/** One watchdog per process; idempotent. Skips probing while frpc itself is down (the
 * keepalive owns that window) and while a probe would race a just-issued restart. */
function startTunnelHealthWatchdog(publicUrl: string, cfg: PublicAccessConfig, log: Logger): void {
  if (healthTimer) return;
  const tracker = new TunnelHealthTracker();
  // 升级阶梯:短暂故障立即重启自愈;确诊长期不健康(闸门政策性拒绝/注册表重建/断网)
  // 后重启指数退避、重分配冷却——健康或空闲即复位。没有退避的旧行为会让 grant 到期的
  // 网关无限高频重启 frpc、每轮重发 NewProxy(katelier 案例:月均 3.3 万次拒绝)。
  const policy = new TunnelWatchdogPolicy();
  const hasExplicitSubdomain = Boolean(cfg.subdomain?.trim());
  const timer = setInterval(() => {
    if (stopped || !child) return;
    // An empty set is an intentional control-plane decision: this gateway currently has no
    // entitled Apple account, so frpc has no proxy to expose. Treat it as healthy/idle instead of
    // repeatedly restarting and eventually reallocating the stable base subdomain.
    if (servedSubdomains.length === 0) {
      tracker.note(true);
      policy.noteIdle();
      return;
    }
    void probeTunnelHealth(publicUrl).then((ok) => {
      if (stopped || !child) return;
      if (ok) {
        policy.noteHealthy();
      }
      if (tracker.note(ok)) {
        const action = policy.noteRestartWindowFired(hasExplicitSubdomain);
        if (action.kind === "realloc") {
          log(
            `tunnel health: restart cycles without recovery — discarding local ` +
              `subdomain allocation and re-running bring-up (relay registry may have been rebuilt)`,
          );
          discardLocalSubdomainAllocation();
          stopPublicAccess();
          void startPublicAccess(cfg, log);
          return;
        }
        if (action.kind === "skip") {
          log(
            `tunnel health: still unreachable — holding (backoff); the standby poll or the next ` +
              `allowed restart will recover when the relay answers`,
          );
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
        log(
          `tunnel health: probe failed (${tracker.consecutiveFailures}/${TUNNEL_HEALTH_STRIKES})`,
        );
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

/**
 * Interfaces that answer with an address other machines on the LAN cannot reach — container
 * bridges, VM host adapters, VPN/overlay tunnels. Picking one of these as the advertised
 * `lanUrl` bricks pairing outright: `PairingVoucherClaim` tries ONLY the LAN address, so the
 * voucher exchange dies and the user reads it as "can't connect".
 */
const VIRTUAL_IFACE_NAME =
  /^(docker|br-|bridge|virbr|veth|vmenet|vnic|utun|tun|tap|tailscale|zt|wg|anpi|llw|awdl|feth)/i;

/**
 * Pick the LAN IP from an interface enumeration, skipping virtual adapters. Pure — exported
 * for tests. Falls back to the first non-internal IPv4 (old behavior) when everything looks
 * virtual, because a wrong-subnet answer still beats no answer at all.
 */
export function pickLanIpFromInterfaces(
  ifaces: ReturnType<typeof networkInterfaces>,
): string | null {
  let firstNonInternal: string | null = null;
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] ?? []) {
      if (net.family !== "IPv4" || net.internal) continue;
      firstNonInternal ??= net.address;
      if (!VIRTUAL_IFACE_NAME.test(name)) return net.address;
    }
  }
  return firstNonInternal;
}

/**
 * The machine's outbound LAN IP via a kernel routing-table query: UDP `connect()` binds the
 * socket to whatever source address the default route would use, WITHOUT sending a single
 * packet — works offline, behind CGNAT, and needs no reply from the probe address. This is
 * the only reliable answer on multi-NIC hosts (Docker bridges, VM adapters, VPNs), where
 * "first enumerated interface" is a coin toss. 223.5.5.5 (AliDNS) rather than 8.8.8.8 so
 * that even a network stack that somehow escalates the query to real traffic stays routable
 * from mainland China. Falls back to enumeration with virtual adapters filtered out.
 */
function getLanIp(): Promise<string> {
  return new Promise((resolve) => {
    const fallback = () => resolve(pickLanIpFromInterfaces(networkInterfaces()) ?? "127.0.0.1");
    try {
      const socket = createSocket("udp4");
      const done = (ip: string | null) => {
        socket.close();
        if (ip && ip !== "0.0.0.0") resolve(ip);
        else fallback();
      };
      socket.on("error", () => done(null));
      socket.connect(53, "223.5.5.5", () => {
        try {
          done(socket.address().address);
        } catch {
          done(null);
        }
      });
    } catch {
      fallback();
    }
  });
}

const execFileAsync = promisify(execFile);

function frpcVersionPath(): string {
  return join(DATA_DIR, "frpc.version");
}

/**
 * Download + checksum-verify + extract the frpc binary for this platform. A version marker
 * file makes `FRP_VERSION` bumps actually reach existing installs (a bare `existsSync` check
 * would pin old users to the first binary forever — frp security fixes could never ship).
 * The download is async so a slow fetch can't block the gateway's event loop. The FridayTunnel
 * control plane is tried first because GitHub Releases is routinely unreachable from mainland
 * cloud providers; GitHub remains the independent fallback. Every archive is checked against a
 * checksum pinned in the shipped plugin, so neither source is a supply-chain trust dependency.
 */
async function ensureBinary(controlPlaneUrl: string, log: Logger): Promise<void> {
  const p = frpcPath();
  const installed = existsSync(frpcVersionPath())
    ? readFileSync(frpcVersionPath(), "utf8").trim()
    : "";
  if (existsSync(p) && installed === FRP_VERSION) return;
  ensureDir();
  const plat = platform() === "darwin" ? "darwin" : "linux";
  const a = arch() === "arm64" ? "arm64" : "amd64";
  const base = `frp_${FRP_VERSION}_${plat}_${a}`;
  const expectedSHA256 = expectedFrpcArchiveSHA256(base);
  if (!expectedSHA256) throw new Error(`unsupported frpc platform: ${plat}/${a}`);
  const tgz = join(DATA_DIR, "frp.tgz");
  const partial = `${tgz}.part`;
  const sources = frpcDownloadSources(controlPlaneUrl, base);
  const failures: string[] = [];
  for (const source of sources) {
    const sourceHost = new URL(source).host;
    log(`downloading frpc ${base} from ${sourceHost} …`);
    try {
      await execFileAsync(
        "curl",
        [
          "--fail",
          "--silent",
          "--show-error",
          "--location",
          "--connect-timeout",
          "10",
          "--max-time",
          "120",
          "--output",
          partial,
          source,
        ],
        { timeout: 130_000 },
      );
      const got = createHash("sha256").update(readFileSync(partial)).digest("hex");
      if (got.toLowerCase() !== expectedSHA256) {
        throw new Error(`checksum mismatch (got ${got.slice(0, 12)}…)`);
      }
      renameSync(partial, tgz);
      failures.length = 0;
      break;
    } catch (error) {
      rmSync(partial, { force: true });
      const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
      failures.push(`${sourceHost}: ${detail}`);
      log(`frpc source ${sourceHost} failed — trying fallback`);
    }
  }
  if (failures.length) {
    throw new Error(`frpc download failed (${failures.join("; ")})`);
  }
  execFileSync("tar", ["xzf", tgz, "-C", DATA_DIR, "--strip-components=1", `${base}/frpc`], {
    timeout: 60_000,
  });
  chmodSync(p, 0o755);
  writeFileSync(frpcVersionPath(), FRP_VERSION);
  log(
    `frpc ${FRP_VERSION} installed (checksum ok)${installed ? ` — upgraded from ${installed}` : ""}`,
  );
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

/** SHA-256 of the RSA public key's PKCS#1 DER bytes. This exactly matches iOS
 * `SecKeyCopyExternalRepresentation` for the gateway certificate and lets a remotely activating
 * app seed a host pin before its first public connection (no TOFU window). */
function gatewayPublicKeyPin(): string {
  const key = ensureGatewayKey();
  const der = createPublicKey(readFileSync(key, "utf8")).export({
    type: "pkcs1",
    format: "der",
  });
  return createHash("sha256").update(der).digest("hex");
}

/** Persisted self-signed leaf for `cn` + its SHA-256 fingerprint (lowercase hex, no colons).
 * `crtName` lets each per-Apple-ID subdomain keep its own cert file off the shared key. */
function ensureCert(
  cn: string,
  crtName = "gateway-cert.pem",
): { crt: string; key: string; fingerprint: string } {
  const key = ensureGatewayKey();
  const crt = join(DATA_DIR, crtName);
  if (!existsSync(crt)) {
    execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-x509",
        "-key",
        key,
        "-out",
        crt,
        "-days",
        "3650",
        "-nodes",
        "-subj",
        `/CN=${cn}`,
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
    const keyHash = createHash("sha256")
      .update(cfg.authToken || "")
      .digest("hex");
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

/**
 * Relay credentials (frps address + shared auth token).
 *
 * These are deployment facts, not user preferences, so they are no longer written into every
 * user's `openclaw.json` — a copy of the shared frps token in thousands of config files is pure
 * leak surface and goes stale the moment the relay moves. The gateway fetches them at bring-up
 * instead, and an explicit `relayAddr`/`relayToken` in config still wins (self-hosters running
 * their own frps, and every install that was configured by hand before this).
 *
 * Cached to disk so a control-plane outage can't take down a tunnel that was already working.
 */
export async function resolveRelayCredentials(
  cfg: PublicAccessConfig,
  log: Logger,
): Promise<PublicAccessConfig | null> {
  if (cfg.relayToken.trim() && cfg.relayAddr.trim()) return cfg;

  const cachePath = join(DATA_DIR, "relay-bootstrap.json");
  const base = cfg.controlPlaneUrl.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/v1/relay/bootstrap`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      relayAddr?: unknown;
      relayToken?: unknown;
      subDomainHost?: unknown;
      region?: unknown;
    };
    const relayAddr = typeof body.relayAddr === "string" ? body.relayAddr.trim() : "";
    const relayToken = typeof body.relayToken === "string" ? body.relayToken.trim() : "";
    const subDomainHost =
      typeof body.subDomainHost === "string" && body.subDomainHost.trim()
        ? body.subDomainHost.trim()
        : cfg.subDomainHost;
    const region = typeof body.region === "string" && body.region.trim() ? body.region.trim() : "";
    if (!relayAddr || !relayToken) throw new Error("incomplete bootstrap payload");
    ensureDir();
    writeFileSync(cachePath, JSON.stringify({ relayAddr, relayToken, subDomainHost, region }), {
      mode: 0o600,
    });
    chmodSync(cachePath, 0o600); // `mode` only applies on create — tighten a pre-existing file too
    log(
      `relay bootstrap: region=${region || "default"} relay=${relayAddr} subDomainHost=${subDomainHost}`,
    );
    return { ...cfg, relayAddr, relayToken, subDomainHost, ...(region ? { region } : {}) };
  } catch (e) {
    log(`relay bootstrap failed (${e instanceof Error ? e.message : String(e)})`);
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as {
        relayAddr?: string;
        relayToken?: string;
        subDomainHost?: string;
        region?: string;
      };
      if (cached.relayAddr && cached.relayToken) {
        log("using cached relay credentials");
        return {
          ...cfg,
          relayAddr: cached.relayAddr,
          relayToken: cached.relayToken,
          subDomainHost: cached.subDomainHost?.trim() || cfg.subDomainHost,
          region: cached.region?.trim() || cfg.region,
        };
      }
    } catch {
      /* no usable cache */
    }
    return null;
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
  const explicit = cfg.subdomain?.trim();
  if (explicit) {
    if (!isValidSubdomainLabel(explicit)) {
      log(`configured subdomain "${explicit}" is not a valid DNS label — refusing to use it`);
      return null;
    }
    return explicit;
  }
  const key = createHash("sha256")
    .update(cfg.authToken || "")
    .digest("hex");
  const f = subdomainPath();
  if (existsSync(f)) {
    const s = readFileSync(f, "utf8").trim();
    const allocKey = existsSync(subdomainKeyPath())
      ? readFileSync(subdomainKeyPath(), "utf8").trim()
      : ""; // pre-key-file installs: keep the record and stamp the current key below
    if (s && isValidSubdomainLabel(s) && (!allocKey || allocKey === key)) {
      if (!allocKey) writeFileSync(subdomainKeyPath(), key);
      return s;
    }
    if (s) log(`gateway key changed — discarding stale subdomain allocation "${s}"`);
    discardLocalSubdomainAllocation();
  }
  ensureDir();
  try {
    const sub = await requestAllocation(cfg.allocatorUrl, cfg.relayToken, key);
    if (!isValidSubdomainLabel(sub)) {
      log(`allocator returned a malformed subdomain "${sub}" — refusing`);
      return null;
    }
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
  return specs;
}

function frpcPidPath(): string {
  return join(DATA_DIR, "frpc.pid");
}

/** A delayed exit from an old frpc must never erase the pidfile of its replacement. */
export function shouldClearRecordedFrpcPid(
  recordedPid: number,
  exitedPid: number | undefined,
): boolean {
  return Number.isInteger(recordedPid) && recordedPid > 0 && recordedPid === exitedPid;
}

/** Remove the pidfile only when it still names the child whose error/exit event fired. */
function clearRecordedFrpcPid(exitedPid: number | undefined): void {
  if (!exitedPid) return;
  try {
    const recordedPid = Number(readFileSync(frpcPidPath(), "utf8").trim()) || 0;
    if (shouldClearRecordedFrpcPid(recordedPid, exitedPid)) {
      rmSync(frpcPidPath(), { force: true });
    }
  } catch {
    /* absent/unreadable pidfile — nothing to clear */
  }
}

/** Parse `ps -Ao pid=,command=` and select only this plugin's exact frpc invocation. */
export function pluginFrpcPidsFromProcessList(
  processList: string,
  executablePath: string,
  confPath: string,
): number[] {
  const expectedCommand = `${executablePath} -c ${confPath}`;
  return processList
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => match != null && match[2] === expectedCommand)
    .map((match) => Number(match[1]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function pluginFrpcProcessIds(confPath: string): number[] {
  try {
    const processList = execFileSync("ps", ["-Ao", "pid=,command="], { timeout: 5_000 }).toString();
    return pluginFrpcPidsFromProcessList(processList, frpcPath(), confPath);
  } catch {
    return [];
  }
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
 * stopPublicAccess ran). The pidfile is not sufficient by itself: a second crash can overwrite
 * it and strand an older child forever. Isolation from a user's own frp remains structural —
 * candidates must have the exact plugin-private executable AND config paths. The pidfile is
 * included as a recovery hint, but its command line is verified before any signal is sent.
 */
function killOrphanFrpc(confPath: string, log: Logger): void {
  let recordedPid = 0;
  try {
    recordedPid = Number(readFileSync(frpcPidPath(), "utf8").trim()) || 0;
  } catch {
    /* process scan below still catches orphans whose pidfile was lost/overwritten */
  }

  const candidates = new Set(pluginFrpcProcessIds(confPath));
  if (recordedPid > 0) candidates.add(recordedPid);
  for (const pid of candidates) {
    if (pid === child?.pid) continue;
    const cmd = processCmdline(pid);
    if (!cmd || !cmd.includes(frpcPath()) || !cmd.includes(confPath)) continue;
    try {
      process.kill(pid, "SIGTERM");
      log(`reaped orphan frpc pid=${pid}`);
    } catch {
      /* already gone */
    }
  }

  // Never leave a dead/reused orphan pid looking like the currently managed child.
  if (recordedPid > 0 && recordedPid !== child?.pid) {
    const cmd = processCmdline(recordedPid);
    if (!cmd || !cmd.includes(frpcPath()) || !cmd.includes(confPath)) {
      try {
        rmSync(frpcPidPath(), { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

const RESPAWN_BASE_MS = 3000;
const RESPAWN_MAX_MS = 60_000;
let respawnDelayMs = RESPAWN_BASE_MS;

function scheduleRespawn(confPath: string, log: Logger): void {
  if (keepaliveTimer) clearTimeout(keepaliveTimer);
  keepaliveTimer = setTimeout(() => {
    keepaliveTimer = null;
    if (!stopped && !child && servedSubdomains.length > 0) spawnFrpc(confPath, log);
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
    clearRecordedFrpcPid(c.pid);
    if (child !== c) return;
    child = null;
    if (stopped) return;
    bumpBackoff();
    log(`frpc spawn error (${err.message}); retrying in ${Math.round(respawnDelayMs / 1000)}s`);
    scheduleRespawn(confPath, log);
  });
  c.on("exit", (code) => {
    clearRecordedFrpcPid(c.pid);
    if (child !== c) return; // superseded by a newer child — ignore this stale exit
    child = null;
    if (stopped) return;
    bumpBackoff();
    log(
      `frpc exited (code=${code ?? "null"}); respawning in ${Math.round(respawnDelayMs / 1000)}s`,
    );
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
    if (stopped || baseTunnel) return;
    // 走 tunnelTransition：重新拉起隧道会重写 frpc.toml 并重启子进程,
    // 不能和在途的 reconcileServedSubdomains 交叠（此前这条路径绕过了闸门）。
    tunnelTransition = tunnelTransition
      .catch(() => undefined)
      .then(async () => {
        if (stopped || baseTunnel) return; // 排到队时世界可能已经变了
        await startPublicAccess(cfg, log);
      });
  }, 30_000);
}

/** Daily check: renew the LE cert before it lapses on a long-running gateway (it only used to
 * be checked at startup — 90-day certs expired under gateways that never restart), then respawn
 * frpc so the LIVE tunnel actually serves the renewed cert and refresh the cached pairing so
 * QR fingerprints match reality. */
function startCertRenewalTimer(cfg: PublicAccessConfig, cn: string, log: Logger): void {
  if (certRenewalTimer) return;
  const timer = setInterval(
    () => {
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
    },
    24 * 3600 * 1000,
  );
  timer.unref?.();
  certRenewalTimer = timer;
}

/** Enter FridayTunnel standby. Returns pairing coordinates even when no public proxy is active. */
export async function startPublicAccess(
  rawCfg: PublicAccessConfig,
  log: Logger,
): Promise<PairingInfo | null> {
  let cfg = rawCfg;
  if (!cfg.enabled) {
    // Hidden operator hard stop. Normal unentitled users never enter this branch: they stay in
    // standby with zero proxies. Reap a prior-process frpc as well so zero-egress is literal.
    const wasRunning = child != null || filterServer != null || cachedPairing != null;
    stopPublicAccess();
    killOrphanFrpc(join(DATA_DIR, "frpc.toml"), log);
    log(
      `FridayTunnel standby hard-disabled (publicAccess.standbyDisabled=true or legacy enabled=false)` +
        (wasRunning ? " — tore down running tunnel" : ""),
    );
    return null;
  }
  stopped = false;
  if (baseTunnel && cachedPairing) {
    startGatewaySubdomainPoll(cfg, log);
    return cachedPairing;
  }
  ensureDir();

  // Relay address + token: from config when set, otherwise from the control plane. Without
  // them frpc could only fail to authenticate, so block and retry rather than spawn it.
  const withRelay = await resolveRelayCredentials(cfg, log);
  if (!withRelay) {
    log(
      "public access blocked: no relay credentials (control plane unreachable?) — retrying in 30s",
    );
    scheduleBringUpRetry(rawCfg, log);
    return null;
  }
  cfg = withRelay;

  // Allocate the stable identity while idle. This does not create a proxy or public listener.
  const subdomain = await resolveSubdomain(cfg, log);
  if (!subdomain) {
    log("public access blocked: no subdomain allocated (relay unreachable?) — retrying in 30s");
    scheduleBringUpRetry(cfg, log);
    return null;
  }
  const cn = `${subdomain}.${cfg.subDomainHost}`;
  const { crt, key, fingerprint } = await ensureRealCert(cfg, cn, log);
  baseTunnel = { sub: subdomain, crt, key, cn };
  servedSubdomains = [];

  cachedPairing = {
    v: 2, // superset schema with a one-time pairing voucher minted per fetch (D12)
    lanUrl: `http://${await getLanIp()}:${cfg.corePort}`,
    publicUrl: `https://${cn}`,
    fingerprint,
    token: cfg.authToken,
    subdomain,
  };

  // A crash/restart may have left yesterday's entitled frpc alive. Standby always begins closed;
  // the authoritative desired-set response below is the only thing allowed to reopen it.
  killOrphanFrpc(join(DATA_DIR, "frpc.toml"), log);
  startCertRenewalTimer(cfg, cn, log);
  startGatewaySubdomainPoll(cfg, log);

  log(
    `FridayTunnel standby → ${cachedPairing.publicUrl} (no proxy; pin ${gatewayPublicKeyPin().slice(0, 16)}…)`,
  );
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
 * ones stop). The control-plane list is authoritative, including an empty list: under grant
 * enforcement the base owner must not remain reachable after their entitlement ends.
 */
export async function reconcileServedSubdomains(
  cfg: PublicAccessConfig,
  desired: string[],
  log: Logger,
): Promise<boolean> {
  if (!baseTunnel) return false;
  const next = normalizedServedSubdomains(desired);
  const rejected = desired.filter((s) => Boolean(s) && !isValidSubdomainLabel(s));
  if (rejected.length) {
    log(`ignoring ${rejected.length} malformed subdomain(s) from the control plane`);
  }
  const cur = Array.from(new Set(servedSubdomains)).sort();
  if (next.length === cur.length && next.every((s, i) => s === cur[i])) return false;
  const added = next.filter((s) => !cur.includes(s));
  const removed = cur.filter((s) => !next.includes(s));
  if (next.length === 0) {
    servedSubdomains = [];
    if (keepaliveTimer) {
      clearTimeout(keepaliveTimer);
      keepaliveTimer = null;
    }
    const running = child;
    child = null;
    try {
      running?.kill();
    } catch {
      /* already gone */
    }
    if (filterServer) {
      const server = filterServer;
      filterServer = null;
      void server.close().catch(() => undefined);
    }
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
    spawnConfPath = null;
    log(`FridayTunnel entered standby (-${removed.length}); frpc stopped, no public proxy`);
    return true;
  }

  // Entitlement exists: only now pay the download/process/listener cost and expose the allowlisted
  // Friday surface. Serialisation prevents overlapping long-poll responses from double-spawning.
  try {
    await ensureBinary(cfg.controlPlaneUrl, log);
    if (!filterServer) {
      const openclawBackend: TunnelBackend = {
        id: "openclaw",
        pathPrefixes: ["/friday-next", "/friday-next-admin", "/gateway", "/__openclaw__"],
        localPort: cfg.corePort,
        requiresAttest: true,
        // DENY beats ALLOW. The __openclaw__ namespace ALSO hosts the ControlUI admin panel
        // plus config/api surfaces, and core serves /__openclaw__/control and the bare
        // /__openclaw__ index WITHOUT auth. The bare-index entry is an exact-root deny in the
        // edge (the path itself and its trailing-slash form) so the canvas subtree stays routable.
        denyPrefixes: [
          "/__openclaw__/control",
          "/__openclaw__/config",
          "/__openclaw__/api",
          "/__openclaw__",
        ],
        // Pre-token bootstrap routes that must stay reachable through the public edge without a
        // session token; everything else on the openclaw backend is gated at the edge now.
        attestExemptPaths: [
          "/friday-next/attest",
          "/friday-next/health",
          "/friday-next/status",
          "/friday-next/plugin/info",
          "/friday-next/public-access/pairing",
          "/friday-next/pair/claim",
        ],
      };
      const backends: TunnelBackend[] = [openclawBackend];
      const conductorPort = resolveConductorPort(cfg);
      if (conductorPort > 0) {
        backends.push({
          id: "conductor",
          pathPrefixes: ["/cap"],
          localPort: conductorPort,
          localHost: resolveConductorHost(cfg),
          requiresAttest: true,
          // D6: only CAP-known routes are reachable through the public tunnel. The edge matches
          // allowedPaths with the same segment-boundary semantics, so e.g. /cap/sessions covers
          // /cap/sessions/{key}/messages and /cap/sessions/{key}/settings.
          allowedPaths: [
            "/cap/hello",
            "/cap/health",
            "/cap/events",
            "/cap/models",
            "/cap/cancel",
            "/cap/files",
            "/cap/approvals",
            "/cap/sessions",
            "/cap/workspaces",
          ],
          // The pre-attest probe must work; everything else on /cap is gated.
          attestExemptPaths: ["/cap/health"],
        });
      }
      filterServer = startTunnelEdge({
        listenPort: filterPort(cfg.corePort),
        backends,
        log,
        attestGate: {
          enabled: () =>
            resolveFridayNextConfig(getHostOpenClawConfigSnapshot(getFridayNextRuntime().config))
              .appAttest.gatePublicSurfaces,
          verify: (t) => verifySession(t, Date.now()),
        },
      });
    }
  } catch (e) {
    log(
      `FridayTunnel activation preparation failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
  servedSubdomains = next;
  const confPath = rewriteConfigForServed(cfg);
  log(`FridayTunnel desired set changed (+${added.length}/-${removed.length}); activating relay`);
  if (child) {
    child.kill(); // exit handler respawns from the rewritten config
  } else {
    killOrphanFrpc(confPath, log);
    spawnFrpc(confPath, log);
  }
  startTunnelHealthWatchdog(`https://${baseTunnel.cn}`, cfg, log);
  return true;
}

/** A DNS label we are willing to put in frpc.toml and in a filename. The control plane is
 * first-party, but these strings are interpolated into a config file (`subdomain = "…"`) and into
 * a cert path (`sub-<label>.pem`) — a quote/newline would be config injection and a `../` would
 * write outside the plugin data dir. Validating the shape costs nothing and removes the class. */
export function isValidSubdomainLabel(value: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

/** Canonical normalization for the control-plane-authoritative proxy set. Exported so tests
 * exercise the exact production decision instead of maintaining a look-alike implementation. */
export function normalizedServedSubdomains(desired: string[]): string[] {
  return Array.from(new Set(desired.filter((s) => Boolean(s) && isValidSubdomainLabel(s)))).sort();
}

/** Telegram-style held HTTP standby: register the gateway's stable identity + public-key pin,
 * then wait for desired-set revisions. The endpoint carries no messages or remote commands. */
function startGatewaySubdomainPoll(cfg: PublicAccessConfig, log: Logger): void {
  if (subdomainPollTimer) return;
  const generation = standbyLoop.begin();
  if (generation === null) return; // 已有活循环（可能正挂在 25s 长轮询上）
  const gatewayKey = createHash("sha256")
    .update(cfg.authToken || "")
    .digest("hex");
  const base = cfg.controlPlaneUrl.replace(/\/$/, "");
  const standbyUrl = `${base}/v1/gateway/standby`;
  const legacyUrl = `${base}/v1/gateway/subdomains`;
  const schedule = (delayMs: number): void => {
    // 代际不符 = 这条循环在 await 期间被 stop 作废了（之后可能已开了新的）：直接退场，
    // 不要再排下一拍，也不要去动新循环的定时器。
    if (stopped || !standbyLoop.isCurrent(generation)) {
      standbyLoop.end(generation);
      return;
    }
    subdomainPollTimer = setTimeout(() => {
      subdomainPollTimer = null;
      void poll();
    }, delayMs);
    subdomainPollTimer.unref?.();
  };
  const poll = async (): Promise<void> => {
    if (stopped || !baseTunnel || !standbyLoop.isCurrent(generation)) {
      standbyLoop.end(generation);
      return;
    }
    let retryDelay = STANDBY_NEXT_POLL_MS;
    try {
      let res = await fetch(standbyUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gatewayKey,
          subdomain: baseTunnel.sub,
          publicKeyPin: gatewayPublicKeyPin(),
          revision: standbyRevision,
          waitSec: STANDBY_WAIT_SEC,
        }),
        signal: AbortSignal.timeout((STANDBY_WAIT_SEC + 10) * 1_000),
      });
      // Rolling deployment compatibility: old control planes know only the immediate endpoint.
      if (res.status === 404) {
        res = await fetch(legacyUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gatewayKey }),
          signal: AbortSignal.timeout(10_000),
        });
        retryDelay = 30_000;
      }
      if (!res.ok) {
        retryDelay = STANDBY_ERROR_RETRY_MS;
        return;
      }
      const data = (await res.json()) as { subdomains?: unknown; revision?: unknown };
      const subs = Array.isArray(data.subdomains)
        ? data.subdomains.filter((s): s is string => typeof s === "string")
        : [];
      // 长轮询挂了最多 25 秒，回来时世界可能已经变了：被 stop 作废的旧循环不许再改全局状态。
      if (stopped || !standbyLoop.isCurrent(generation)) return;
      if (typeof data.revision === "string") standbyRevision = data.revision;
      tunnelTransition = tunnelTransition
        .catch(() => undefined)
        .then(() => reconcileServedSubdomains(cfg, subs, log).then(() => undefined));
      await tunnelTransition;
    } catch {
      // Fail-open for an already-authorized live tunnel during a short CP outage; entitlement
      // expiry is still enforced independently by frps. Standby simply retries with backoff.
      retryDelay = STANDBY_ERROR_RETRY_MS;
    } finally {
      schedule(retryDelay);
    }
  };
  void poll();
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
    clearTimeout(subdomainPollTimer);
    subdomainPollTimer = null;
  }
  standbyLoop.invalidate(); // 在途的长轮询醒来即退场，不会与随后 start 的新循环并存
  standbyRevision = "";
  tunnelTransition = Promise.resolve();
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
    const server = filterServer;
    filterServer = null;
    void server.close().catch(() => undefined);
  }
}

/** Test/introspection: the subdomains currently written into frpc.toml. */
export function currentServedSubdomains(): string[] {
  return [...servedSubdomains];
}

export function getPairingInfo(): PairingInfo | null {
  return cachedPairing;
}
