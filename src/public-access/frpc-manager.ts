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
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, platform, arch, networkInterfaces } from "node:os";
import { join } from "node:path";

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
let stopped = false;
let keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
let allocRetryTimer: ReturnType<typeof setTimeout> | null = null;
let cachedPairing: PairingInfo | null = null;

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

/** Download + checksum-verify + extract the frpc binary for this platform (once). */
function ensureBinary(log: Logger): void {
  const p = frpcPath();
  if (existsSync(p)) return;
  ensureDir();
  const plat = platform() === "darwin" ? "darwin" : "linux";
  const a = arch() === "arm64" ? "arm64" : "amd64";
  const base = `frp_${FRP_VERSION}_${plat}_${a}`;
  const rel = `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}`;
  const tgz = join(DATA_DIR, "frp.tgz");
  log(`downloading frpc ${base} …`);
  execFileSync("curl", ["-fsSL", "-o", tgz, `${rel}/${base}.tar.gz`], { timeout: 180_000 });

  // Supply-chain: verify against the release's published sha256 checksums.
  const sums = execFileSync("curl", ["-fsSL", `${rel}/frp_sha256_checksums.txt`], {
    timeout: 60_000,
  }).toString();
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
  log("frpc installed (checksum ok)");
}

/** Persisted self-signed leaf + its SHA-256 fingerprint (lowercase hex, no colons). */
function ensureCert(cn: string): { crt: string; key: string; fingerprint: string } {
  ensureDir();
  const crt = join(DATA_DIR, "gateway-cert.pem");
  const key = join(DATA_DIR, "gateway-key.pem");
  if (!existsSync(crt) || !existsSync(key)) {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048",
        "-keyout", key, "-out", crt,
        "-days", "3650", "-nodes", "-subj", `/CN=${cn}`,
      ],
      { timeout: 30_000 },
    );
  }
  const fingerprint = execFileSync("openssl", ["x509", "-in", crt, "-noout", "-fingerprint", "-sha256"])
    .toString()
    .split("=")[1]
    .replace(/:/g, "")
    .trim()
    .toLowerCase();
  return { crt, key, fingerprint };
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

/**
 * Resolve this gateway's subdomain, collision-proof by construction:
 *   1. explicit `cfg.subdomain` override, else
 *   2. the locally-persisted allocation (`subdomain.txt`), else
 *   3. a fresh allocation from the relay registry keyed by sha256(authToken).
 * Returns null when step 3 can't reach the relay — the caller then BLOCKS public
 * access rather than minting a locally-random subdomain (which could collide).
 */
async function resolveSubdomain(cfg: PublicAccessConfig, log: Logger): Promise<string | null> {
  if (cfg.subdomain && cfg.subdomain.trim()) return cfg.subdomain.trim();
  const f = join(DATA_DIR, "subdomain.txt");
  if (existsSync(f)) {
    const s = readFileSync(f, "utf8").trim();
    if (s) return s;
  }
  ensureDir();
  const key = createHash("sha256").update(cfg.authToken || "").digest("hex");
  try {
    const sub = await requestAllocation(cfg.allocatorUrl, cfg.relayToken, key);
    writeFileSync(f, sub);
    log(`allocated subdomain "${sub}" from relay registry`);
    return sub;
  } catch (e) {
    log(`subdomain allocation failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function writeFrpcConfig(cfg: PublicAccessConfig, subdomain: string, crt: string, key: string): string {
  const [host, portRaw] = cfg.relayAddr.split(":");
  const port = Number(portRaw) || 7000;
  const toml = `serverAddr = "${host}"
serverPort = ${port}
auth.token = "${cfg.relayToken}"
log.to = "${join(DATA_DIR, "frpc.log")}"
log.level = "info"
log.maxDays = 3

[[proxies]]
name = "friday-next-public"
type = "https"
subdomain = "${subdomain}"
[proxies.plugin]
type = "https2http"
localAddr = "127.0.0.1:${cfg.corePort}"
crtPath = "${crt}"
keyPath = "${key}"
`;
  const p = join(DATA_DIR, "frpc.toml");
  writeFileSync(p, toml);
  return p;
}

/** Kill any orphan frpc from a prior gateway process (matched by our unique config path). Called
 * ONCE at start — never in the respawn path, or it would kill our own live child and flap. */
function killOrphanFrpc(confPath: string): void {
  try {
    execFileSync("pkill", ["-f", confPath]);
  } catch {
    /* none running */
  }
}

function spawnFrpc(confPath: string, log: Logger): void {
  const c = spawn(frpcPath(), ["-c", confPath], { stdio: "ignore", detached: false });
  child = c;
  c.on("exit", (code) => {
    if (child !== c) return; // superseded by a newer child — ignore this stale exit
    child = null;
    if (stopped) return;
    log(`frpc exited (code=${code ?? "null"}); respawning in 3s`);
    keepaliveTimer = setTimeout(() => {
      if (!stopped && !child) spawnFrpc(confPath, log);
    }, 3000);
  });
}

/** Bring public access up. Returns the pairing info (also cached for the HTTP endpoint). */
export async function startPublicAccess(
  cfg: PublicAccessConfig,
  log: Logger,
): Promise<PairingInfo | null> {
  if (!cfg.enabled) {
    log("public access disabled (channels.friday-next.publicAccess.enabled=false)");
    return null;
  }
  stopped = false;
  ensureDir();
  ensureBinary(log);

  // Block (don't tunnel) until the relay hands us a collision-proof subdomain; retry
  // so a transient relay outage self-heals without minting a risky local subdomain.
  const subdomain = await resolveSubdomain(cfg, log);
  if (!subdomain) {
    log("public access blocked: no subdomain allocated (relay unreachable?) — retrying in 30s");
    if (allocRetryTimer) clearTimeout(allocRetryTimer);
    if (!stopped) {
      allocRetryTimer = setTimeout(() => {
        allocRetryTimer = null;
        if (!stopped && !child) void startPublicAccess(cfg, log);
      }, 30_000);
    }
    return null;
  }
  const cn = `${subdomain}.${cfg.subDomainHost}`;
  const { crt, key, fingerprint } = ensureCert(cn);
  const confPath = writeFrpcConfig(cfg, subdomain, crt, key);

  // Idempotent: a duplicate registerFull must NOT respawn a live tunnel (that caused flapping).
  if (child && child.exitCode === null && !child.killed) {
    log("public access already running — refreshed config, keeping current frpc");
    return cachedPairing;
  }
  killOrphanFrpc(confPath); // clear a stale frpc from a prior gateway process, once
  spawnFrpc(confPath, log);

  cachedPairing = {
    v: 1,
    lanUrl: `http://${getLanIp()}:${cfg.corePort}`,
    publicUrl: `https://${cn}`,
    fingerprint,
    token: cfg.authToken,
    subdomain,
  };
  log(`public access up → ${cachedPairing.publicUrl} (fp ${fingerprint.slice(0, 16)}…)`);
  return cachedPairing;
}

export function stopPublicAccess(): void {
  stopped = true;
  if (keepaliveTimer) {
    clearTimeout(keepaliveTimer);
    keepaliveTimer = null;
  }
  if (allocRetryTimer) {
    clearTimeout(allocRetryTimer);
    allocRetryTimer = null;
  }
  if (child) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    child = null;
  }
}

export function getPairingInfo(): PairingInfo | null {
  return cachedPairing;
}
