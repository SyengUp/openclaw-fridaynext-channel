/**
 * Public access (FridayNext 云) — thin host adapter over `@syengup/tunnel-edge`'s TunnelRuntime.
 *
 * The shared runtime owns the frpc + edge + standby lifecycle: frpc binary install, gateway
 * keypair/certs, relay bootstrap, subdomain allocation, the Telegram-style control-plane standby
 * poll, the tunnel health watchdog, cert renewal, and frpc/edge child-process supervision.
 * This module only translates the live plugin config and the OpenClaw host surfaces into a
 * `TunnelRuntimeConfig`/`TunnelRuntimeHost` and delegates every lifecycle call.
 *
 * All state still lives under `~/.openclaw/friday-next/public-access/` (the same directory
 * constant as before), so existing subdomain records, certs, pidfiles, and binaries keep
 * working across this refactor and a gateway hot-reload.
 */
import { createSocket } from "node:dgram";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import {
  startTunnelRuntime,
  type ProxyAttestGate,
  type TunnelBackend,
  type TunnelRuntime,
  type TunnelRuntimeConfig,
  type TunnelRuntimeHost,
  type TunnelRuntimePairingInfo,
} from "@syengup/tunnel-edge";
import { verifySession } from "../attest/attest-store.js";
import { resolveFridayNextConfig } from "../config.js";
import { getHostOpenClawConfigSnapshot } from "../host-config.js";
import { getFridayNextRuntime } from "../runtime.js";
import { claimPairingVoucher, mintPairingVoucher } from "./pairing-voucher.js";

export {
  backendTablesEqual,
  isTunnelHealthyStatus,
  isValidSubdomainLabel,
  normalizedServedSubdomains,
  parseControlPlaneBackends,
  pluginFrpcPidsFromProcessList,
  shouldClearRecordedEdgePid,
  shouldClearRecordedFrpcPid,
  TunnelHealthTracker,
} from "@syengup/tunnel-edge";
export { expectedFrpcArchiveSHA256, frpcDownloadSources } from "./frpc-download-source.js";

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
  /** Edge run mode for this bring-up. Defaults to the live plugin config value, which
   * itself defaults to `in-process` — existing deployments keep the embedded edge until
   * `channels["friday-next"].publicAccess.edgeMode` is explicitly set to `"external"`. */
  edgeMode?: "in-process" | "external";
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

export type PairingInfo = TunnelRuntimePairingInfo;

type Logger = (msg: string) => void;

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

/** Resolve the edge run mode for this bring-up. An explicit `PublicAccessConfig.edgeMode`
 * wins; otherwise the live plugin config decides. The plugin config itself defaults to
 * `in-process`, so deployed gateways keep the embedded edge until explicitly switched. */
export function resolveEdgeMode(cfg: PublicAccessConfig): "in-process" | "external" {
  if (cfg.edgeMode === "in-process" || cfg.edgeMode === "external") return cfg.edgeMode;
  const resolved = resolveFridayNextConfig(
    getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
  ).publicAccess.edgeMode;
  return resolved === "external" ? "external" : "in-process";
}

/** JSON shape written for the external edge CLI. Kept local so the plugin does not depend on
 * the edge package's config-file helper exports (only the runtime API + CLI path). */
type EdgeConfigFile = {
  listenPort: number;
  backends: TunnelBackend[];
  logLevel?: "debug" | "info" | "silent";
  /** Localhost attest verifier used by the standalone edge. */
  attest?: { url: string; header?: string };
};

function edgeLogLevelForCurrentConfig(): "debug" | "info" | "silent" {
  const level = resolveFridayNextConfig(
    getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
  ).logLevel;
  return level === "debug" ? "debug" : "info";
}

/**
 * The public edge routing table for this gateway: the OpenClaw core surface always, plus the
 * conductor `/cap` surface when a conductor port is configured. Every field is exactly what the
 * legacy filter proxy enforced — pathPrefixes, denyPrefixes, allowedPaths and attestExemptPaths
 * must stay byte-for-byte compatible with the previously inlined construction.
 */
export function buildTunnelBackends(cfg: PublicAccessConfig): TunnelBackend[] {
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
      // The standalone edge's attest verifier lives on this path on core; it must never be
      // reachable through the public relay (the handler also rejects public-marker requests).
      "/friday-next/edge",
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
  return backends;
}

/** Config file for the standalone edge CLI: the same listen port frpc forwards into, the same
 * backend table the in-process edge would use, and a log level derived from the plugin config.
 * In external mode, when the public-surface attest gate is enabled, the config also points the
 * standalone edge at the plugin's internal localhost verifier so it can enforce App Attest
 * exactly like the in-process edge.
 *
 * Kept as a pure helper for existing tests; the shared TunnelRuntime writes its own edge config
 * from the host adapters and does NOT call this function.
 */
export function edgeConfigFor(cfg: PublicAccessConfig): EdgeConfigFile {
  const attest =
    resolveEdgeMode(cfg) === "external"
      ? ((): EdgeConfigFile["attest"] => {
          const gatePublicSurfaces = resolveFridayNextConfig(
            getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
          ).appAttest.gatePublicSurfaces;
          return gatePublicSurfaces
            ? { url: `http://127.0.0.1:${cfg.corePort}/friday-next/edge/verify-attest` }
            : undefined;
        })()
      : undefined;
  return {
    listenPort: filterPort(cfg.corePort),
    backends: buildTunnelBackends(cfg),
    logLevel: edgeLogLevelForCurrentConfig(),
    ...(attest ? { attest } : {}),
  };
}

function positivePort(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 0;
}

function ensureDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}

function subdomainPath(): string {
  return join(DATA_DIR, "subdomain.txt");
}

function subdomainKeyPath(): string {
  return join(DATA_DIR, "subdomain.key");
}

/** Drop the locally-persisted allocation so the next bring-up re-asks the relay registry.
 * Used when the local record can no longer be trusted (gateway key changed, or the relay
 * keeps rejecting our registration — e.g. its registry was rebuilt without us).
 *
 * LEGACY direct-disk helper. The production path performs the same operation inside
 * `@syengup/tunnel-edge`'s TunnelRuntime; this export is kept for ops/tests.
 */
export function discardLocalSubdomainAllocation(): void {
  try {
    rmSync(subdomainPath(), { force: true });
    rmSync(subdomainKeyPath(), { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Relay credentials (frps address + shared auth token).
 *
 * LEGACY — the production path resolves these inside `@syengup/tunnel-edge`'s TunnelRuntime.
 * Kept exported so the existing relay-bootstrap tests and any operator tooling keep compiling;
 * the behavior is intentionally identical to the shared runtime's copy.
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

// --- Runtime adapter singleton ---------------------------------------------------------------

let runtime: TunnelRuntime | null = null;
let runtimeConfig: PublicAccessConfig | null = null; // the cfg the running runtime was built from

const PUBLIC_ACCESS_LOG_PREFIX = "[friday-next:public-access]";

/**
 * The shared runtime logs through `host.log` with bare messages. Route them through the
 * plugin's public-access prefix here so gateway output stays recognizable regardless of what
 * sink the caller provided.
 */
function withPublicAccessLogPrefix(log: Logger): Logger {
  return (message) => log(`${PUBLIC_ACCESS_LOG_PREFIX} ${message}`);
}

/** Compare only the fields that define the runtime identity. `edgeMode` is compared through
 * `resolveEdgeMode` so an unset value and an explicit `"in-process"` are equivalent. */
function runtimeConfigsEquivalent(a: PublicAccessConfig, b: PublicAccessConfig): boolean {
  return (
    a.corePort === b.corePort &&
    a.authToken === b.authToken &&
    a.controlPlaneUrl === b.controlPlaneUrl &&
    a.allocatorUrl === b.allocatorUrl &&
    a.certSignUrl === b.certSignUrl &&
    a.subDomainHost === b.subDomainHost &&
    (a.subdomain?.trim() || undefined) === (b.subdomain?.trim() || undefined) &&
    (a.relayAddr?.trim() || undefined) === (b.relayAddr?.trim() || undefined) &&
    (a.relayToken?.trim() || undefined) === (b.relayToken?.trim() || undefined) &&
    resolveEdgeMode(a) === resolveEdgeMode(b)
  );
}

/** Enter FridayTunnel standby. Returns pairing coordinates even when no public proxy is active. */
export async function startPublicAccess(
  rawCfg: PublicAccessConfig,
  log: Logger,
): Promise<PairingInfo | null> {
  const logWithPrefix = withPublicAccessLogPrefix(log);
  if (!rawCfg.enabled) {
    // Hidden operator hard stop. Normal unentitled users never enter this branch: they stay in
    // standby with zero proxies. The shared runtime's stop() tears down its own frpc/edge/timers.
    const wasRunning = runtime !== null || runtimeConfig !== null;
    stopPublicAccess();
    logWithPrefix(
      `FridayTunnel standby hard-disabled (publicAccess.standbyDisabled=true or legacy enabled=false)` +
        (wasRunning ? " — tore down running tunnel" : ""),
    );
    return null;
  }

  if (runtime && runtimeConfig && runtimeConfigsEquivalent(runtimeConfig, rawCfg)) {
    // Idempotent: the runtime owns its own standby poll/retry timers from here on.
    return runtime.pairingInfo();
  }

  stopPublicAccess();

  const config: TunnelRuntimeConfig = {
    dataDir: DATA_DIR,
    corePort: rawCfg.corePort,
    authToken: rawCfg.authToken,
    lanUrl: `http://${await getLanIp()}:${rawCfg.corePort}`,
    controlPlaneUrl: rawCfg.controlPlaneUrl,
    allocatorUrl: rawCfg.allocatorUrl,
    certSignUrl: rawCfg.certSignUrl,
    subDomainHost: rawCfg.subDomainHost,
    ...(rawCfg.subdomain?.trim() ? { subdomain: rawCfg.subdomain.trim() } : {}),
    ...(rawCfg.relayAddr?.trim() ? { relayAddr: rawCfg.relayAddr.trim() } : {}),
    ...(rawCfg.relayToken?.trim() ? { relayToken: rawCfg.relayToken.trim() } : {}),
    edgeMode: resolveEdgeMode(rawCfg),
    edgeLogLevel: edgeLogLevelForCurrentConfig(),
  };

  const host: TunnelRuntimeHost = {
    buildBackends: () => buildTunnelBackends(rawCfg),
    attestGate: (): ProxyAttestGate => ({
      enabled: () =>
        resolveFridayNextConfig(getHostOpenClawConfigSnapshot(getFridayNextRuntime().config))
          .appAttest.gatePublicSurfaces,
      verify: (token) => verifySession(token, Date.now()),
    }),
    externalAttestUrl: () => {
      const gatePublicSurfaces = resolveFridayNextConfig(
        getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
      ).appAttest.gatePublicSurfaces;
      return gatePublicSurfaces
        ? `http://127.0.0.1:${rawCfg.corePort}/friday-next/edge/verify-attest`
        : undefined;
    },
    vouchers: {
      mint: () => mintPairingVoucher(),
      claim: (code, nowMs) => claimPairingVoucher(code, nowMs),
    },
    log: logWithPrefix,
  };

  runtime = startTunnelRuntime(config, host);
  runtimeConfig = rawCfg;
  await runtime.start();
  return runtime.pairingInfo();
}

export function stopPublicAccess(): void {
  const running = runtime;
  runtime = null;
  runtimeConfig = null;
  try {
    running?.stop();
  } catch {
    /* stop() is best-effort; adapter state is already cleared */
  }
}

/** Reconcile the served subdomain set against `desired` (from the control-plane poll). The
 * shared runtime owns the set-diff, frpc/edge restart, and backend hot-swap decisions. */
export async function reconcileServedSubdomains(
  cfg: PublicAccessConfig,
  desired: string[],
  _log: Logger,
  desiredBackends: TunnelBackend[] = buildTunnelBackends(cfg),
): Promise<boolean> {
  if (!runtime) return false;
  return runtime.reconcile(desired, desiredBackends);
}

/** Test/introspection: the subdomains currently written into frpc.toml. */
export function currentServedSubdomains(): string[] {
  return runtime ? runtime.servedSubdomains() : [];
}

export function getPairingInfo(): PairingInfo | null {
  return runtime ? runtime.pairingInfo() : null;
}
