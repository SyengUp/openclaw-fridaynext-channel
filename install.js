#!/usr/bin/env node
import { execSync, spawn } from "node:child_process";
import { createSocket as dgramCreateSocket } from "node:dgram";
import { existsSync, openSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { createInstallerUI } from "./install-ui.js";
import { strings } from "./install-i18n.js";

const sudoUser = process.env.SUDO_USER;

function realHome() {
  if (!sudoUser) return homedir();
  const current = homedir();
  if (current !== "/root" && current !== "/var/root" && existsSync(current)) return current;
  for (const g of [`/home/${sudoUser}`, `/Users/${sudoUser}`, `C:\\Users\\${sudoUser}`]) {
    if (existsSync(g)) return g;
  }
  return current;
}

const USER_HOME = realHome();
const OPENCLAW_CONFIG = join(USER_HOME, ".openclaw", "openclaw.json");

// Native Windows: non-interactive shells often omit `%APPDATA%\npm`, where `openclaw.cmd`
// and `npx.cmd` live. Prepend it (and the default Node.js dir) so `has("openclaw")` and
// the later detached `gateway run` resolve the same way a normal desktop PowerShell would.
if (process.platform === "win32") {
  const extra = [
    process.env.APPDATA ? join(process.env.APPDATA, "npm") : "",
    join(process.env.ProgramFiles || "C:\\Program Files", "nodejs"),
  ].filter((p) => p && existsSync(p));
  if (extra.length) process.env.PATH = [...extra, process.env.PATH || ""].join(";");
}

// All output goes through the UI module (install-ui.js) — one line per step, no
// prose. `scripts/preview-install-ui.mjs` drives the same module with fake timings
// when iterating on the look.
// Copy follows the terminal's locale (zh/en); FRIDAY_INSTALL_LANG overrides.
const T = strings();
const ui = createInstallerUI();
process.on("exit", () => ui.cleanup());

/** Print a fatal block and stop. `lines[0]` = what broke, rest = commands to run. */
function die(...lines) {
  ui.cleanup();
  ui.fatal(lines);
  process.exit(1);
}

function has(cmd) {
  try {
    execSync(`${cmd} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let openclawCmd = "openclaw";

function hasOpenclaw() {
  if (has("openclaw")) return true;
  if (!sudoUser) return false;
  try {
    execSync(`sudo -u "${sudoUser}" openclaw --version`, { stdio: "ignore" });
    openclawCmd = `sudo -u "${sudoUser}" openclaw`;
    return true;
  } catch {}
  return false;
}

// --------------- prerequisites ---------------

ui.header();

if (sudoUser) ui.note(T.noteNoSudo);

if (!has("node")) die(T.failNoNode, T.failNoNodeHint);
if (!hasOpenclaw()) die(T.failNoOpenclaw, "https://docs.openclaw.ai");

// --------------- version check ---------------
{
  const MIN_OPENCLAW = [2026, 5, 12];
  try {
    const verOut = execSync(`${openclawCmd} --version`, { encoding: "utf8" }).trim();
    const m = verOut.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/);
    if (m) {
      const cur = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
      let tooOld = false;
      for (let i = 0; i < 3; i++) {
        if (cur[i] > MIN_OPENCLAW[i]) break;
        if (cur[i] < MIN_OPENCLAW[i]) {
          tooOld = true;
          break;
        }
      }
      if (tooOld) die(T.failTooOld(m[0]), `${openclawCmd} update`);
    }
  } catch {
    /* version unreadable — not worth a line; the verify step is the real gate */
  }
}

// --------------- install plugin package ---------------

const PKG = "@syengup/friday-channel-next";

// Which npm dist-tag to install from. `latest` (default) is the stable line real
// users get. `beta` is the opt-in public-access preview line — friends invited to
// test pass `--beta` (or set FRIDAY_CHANNEL_NEXT_CHANNEL=beta). Real users never
// touch beta because they never pass the flag, and beta versions are published
// under a separate dist-tag that never moves `latest`.
const DIST_TAG =
  process.argv.includes("--beta") || process.env.FRIDAY_CHANNEL_NEXT_CHANNEL === "beta"
    ? "beta"
    : "latest";

// Re-run hint printed on failure. Native Windows has no `sh` — the PowerShell equivalent
// (install.ps1) takes arguments via the scriptblock wrap, since `iwr | iex` cannot take any.
const RERUN_CMD =
  process.platform === "win32"
    ? DIST_TAG === "beta"
      ? 'iex "& { $(iwr -useb https://gw.syengup.host/v1/friday-next/install.ps1) } -Beta"'
      : "iwr -useb https://gw.syengup.host/v1/friday-next/install.ps1 | iex"
    : DIST_TAG === "beta"
      ? "curl -fsSL https://gw.syengup.host/v1/friday-next/install.sh | sh -s -- --beta"
      : "curl -fsSL https://gw.syengup.host/v1/friday-next/install.sh | sh";

// Registry selection. Must stay in lockstep with src/npm-registry.ts:
// parallel latency probe, faster wins, close race (150ms) prefers official.
// Reachability-alone used to lock mainland gateways onto a slow-but-reachable
// official registry (observed: 4-minute cold install vs 31s on npmmirror).
// FRIDAY_NPM_REGISTRY override wins without probing. Install failure retries
// once on the other candidate — one channel at a time, never two parallel
// installs. The resolved registry is used for the version lookup AND injected
// into the `openclaw plugins install` subprocess via npm_config_registry.
const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";
const CHINA_MIRROR = "https://registry.npmmirror.com/";
const REGISTRY_CANDIDATES = [OFFICIAL_REGISTRY, CHINA_MIRROR];
const PROBE_TIMEOUT_MS = 3_000;
const RACE_EQUALITY_MS = 150;

/** Probe one registry; returns latency ms, or Infinity if it doesn't answer. */
async function probeRegistryLatency(url) {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/-/ping`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      return res.ok ? Date.now() - started : Infinity;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return Infinity;
  }
}

async function resolveRegistry() {
  const override = process.env.FRIDAY_NPM_REGISTRY;
  if (override && override.trim()) return override.trim();

  const results = await Promise.all(
    REGISTRY_CANDIDATES.map(async (url) => ({
      registry: url,
      latencyMs: await probeRegistryLatency(url),
    })),
  );
  const reachable = results.filter((r) => r.latencyMs !== Infinity);
  const official = results.find((r) => r.registry === OFFICIAL_REGISTRY);

  if (reachable.length === 0) return OFFICIAL_REGISTRY;
  const fastest = reachable.reduce((a, b) => (a.latencyMs < b.latencyMs ? a : b));
  if (
    official &&
    official.latencyMs !== Infinity &&
    fastest.latencyMs + RACE_EQUALITY_MS >= official.latencyMs
  ) {
    return OFFICIAL_REGISTRY;
  }
  return fastest.registry;
}

/** Env to pass to the npm subprocess (null = leave npm's own config alone). */
function installEnvFor(registry) {
  if (registry === OFFICIAL_REGISTRY) return null;
  return { npm_config_registry: registry };
}

/** The other known candidate, or undefined for an explicit FRIDAY_NPM_REGISTRY override. */
function alternateRegistry(preferred) {
  if (!REGISTRY_CANDIDATES.includes(preferred)) return undefined;
  return REGISTRY_CANDIDATES.find((c) => c !== preferred);
}

function registryHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}

// Resolve the EXACT version behind DIST_TAG and install THAT — never the bare
// `@latest`/`@beta` dist-tag. OpenClaw persists a dist-tag install as a caret
// range (`"^1.0.5"`) in the managed project package.json, and OpenClaw's own
// plugin auto-update later rejects that range ("unsupported npm spec: use an
// exact version or dist-tag"), disabling the plugin. An exact version is stored
// as an exact spec, which auto-update accepts.
async function fetchTaggedVersionFromRegistry(registry, distTag) {
  try {
    const res = await fetch(`${registry.replace(/\/$/, "")}/${PKG}/${distTag}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const body = await res.json();
      if (typeof body.version === "string" && /^\d+\.\d+\.\d+/.test(body.version)) {
        return body.version;
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function resolveTaggedVersion(distTag, registry) {
  const candidates = [registry, process.env.FRIDAY_NPM_REGISTRY, OFFICIAL_REGISTRY, CHINA_MIRROR]
    .filter(Boolean)
    .filter((url, i, arr) => arr.indexOf(url) === i);
  for (const candidate of candidates) {
    const v = await fetchTaggedVersionFromRegistry(candidate, distTag);
    if (v) return v;
  }
  try {
    const v = execSync(`npm view ${PKG}@${distTag} version`, {
      encoding: "utf8",
      timeout: 20000,
      env: { ...process.env, ...(installEnvFor(registry) ?? {}) },
    }).trim();
    if (/^\d+\.\d+\.\d+/.test(v)) return v;
  } catch {
    /* fall through */
  }
  return null;
}

const installStep = ui.step(T.stepInstall);

const registry = await resolveRegistry();
const installEnv = installEnvFor(registry);
const resolvedVersion = await resolveTaggedVersion(DIST_TAG, registry);
// Registry lookup failed — fall back to the bare dist-tag so a transient network
// hiccup doesn't block the install. Re-running later pins an exact spec.
const installSpec = `${PKG}@${resolvedVersion ?? DIST_TAG}`;

// OpenClaw 2026.8.1+ refuses `plugins install` until the operator accepts the
// plugin's declared capabilities. COMPAT(openclaw<2026.8.1): older CLIs do not
// have `--accept-capabilities` (unknown option → install fails). Probe --help
// once so we don't spend the 120s timeout discovering that.
let cachedAcceptCapabilitiesFlag;
function acceptCapabilitiesFlag() {
  if (cachedAcceptCapabilitiesFlag !== undefined) return cachedAcceptCapabilitiesFlag;
  try {
    const help = execSync(`${openclawCmd} plugins install --help`, {
      encoding: "utf8",
      timeout: 20000,
    });
    cachedAcceptCapabilitiesFlag = String(help).includes("--accept-capabilities")
      ? " --accept-capabilities"
      : "";
  } catch (err) {
    const extra = `${err?.stdout ?? ""}${err?.stderr ?? ""}`;
    cachedAcceptCapabilitiesFlag = extra.includes("--accept-capabilities")
      ? " --accept-capabilities"
      : "";
  }
  return cachedAcceptCapabilitiesFlag;
}

function runPluginInstall(spec, env) {
  execSync(`${openclawCmd} plugins install ${spec} --force${acceptCapabilitiesFlag()}`, {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 120000,
    env: { ...process.env, ...(env ?? {}) },
  });
}

try {
  try {
    installStep.detail(registryHost(registry));
    runPluginInstall(installSpec, installEnv);
  } catch (first) {
    // Same failover as plugin-upgrade: one retry on the other known candidate.
    // An explicit FRIDAY_NPM_REGISTRY override is authoritative — don't bypass it.
    const alternate = alternateRegistry(registry);
    if (!alternate) throw first;
    installStep.detail(registryHost(alternate));
    runPluginInstall(installSpec, installEnvFor(alternate));
  }

  // Remove old manual install to avoid "duplicate plugin id" warning.
  const legacyDir = join(USER_HOME, ".openclaw", "extensions", "friday-channel-next");
  if (existsSync(legacyDir)) {
    try {
      rmSync(legacyDir, { recursive: true, force: true });
    } catch {
      /* non-critical */
    }
  }
  installStep.ok((resolvedVersion ?? DIST_TAG) + (DIST_TAG === "beta" ? " (beta)" : ""));
} catch (e) {
  const msg = (e.stderr || e.stdout || e.message || "").toString();
  installStep.fail();
  die(msg.trim().split("\n").pop() || T.failInstall, RERUN_CMD);
}

// --------------- configure OpenClaw ---------------

const configStep = ui.step(T.stepConfigure);

let config;
try {
  config = JSON.parse(readFileSync(OPENCLAW_CONFIG, "utf8"));
} catch {
  configStep.fail();
  die(T.failReadConfig(OPENCLAW_CONFIG), T.failReadConfigHint);
}

let configChanged = false;

function setConfig(path, value) {
  const keys = path.split(".");
  let obj = config;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!obj[keys[i]] || typeof obj[keys[i]] !== "object" || Array.isArray(obj[keys[i]])) {
      obj[keys[i]] = {};
    }
    obj = obj[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (JSON.stringify(obj[last]) !== JSON.stringify(value)) {
    obj[last] = value;
    configChanged = true;
  }
}

function ensureArrayContains(arr, item) {
  if (!arr.includes(item)) {
    arr.push(item);
    configChanged = true;
  }
}

// Plugins（新客户端不再使用 canvas 插件/节点画布面）
if (!config.plugins) config.plugins = {};
if (!Array.isArray(config.plugins.allow)) config.plugins.allow = [];
ensureArrayContains(config.plugins.allow, "friday-next");

if (!config.plugins.entries) config.plugins.entries = {};
for (const id of ["friday-next"]) {
  if (!config.plugins.entries[id]) {
    config.plugins.entries[id] = { enabled: true };
    configChanged = true;
  } else if (!config.plugins.entries[id].enabled) {
    config.plugins.entries[id].enabled = true;
    configChanged = true;
  }
}

// llm_output hook requires allowConversationAccess for non-bundled plugins.
if (!config.plugins.entries["friday-next"].hooks) {
  config.plugins.entries["friday-next"].hooks = {};
  configChanged = true;
}
if (!config.plugins.entries["friday-next"].hooks.allowConversationAccess) {
  config.plugins.entries["friday-next"].hooks.allowConversationAccess = true;
  configChanged = true;
}

// Channel — `enabled` only. `transport` used to be written here, but nothing ever read it
// (resolveFridayNextConfig ignores it); it just left a mystery key in every user's config.
if (!config.channels) config.channels = {};
if (!config.channels["friday-next"]) {
  config.channels["friday-next"] = { enabled: true };
  configChanged = true;
} else {
  if (!config.channels["friday-next"].enabled) {
    config.channels["friday-next"].enabled = true;
    configChanged = true;
  }
  // Sweep the dead keys we used to write. They are unread by the plugin, and ControlUI
  // surfaces undeclared keys in a "Custom entries" editor — so leaving them behind means
  // every upgraded install keeps showing a setting that does nothing.
  for (const deadKey of ["transport", "pathPrefix"]) {
    if (deadKey in config.channels["friday-next"]) {
      delete config.channels["friday-next"][deadKey];
      configChanged = true;
    }
  }
}

// Gateway bind（HTTP+SSE 需监听 LAN；节点命令不再注入——新客户端纯 HTTP）
if (!config.gateway) config.gateway = {};
if (config.gateway.bind !== "lan") {
  config.gateway.bind = "lan";
  configChanged = true;
}

// Agent tools
if (!config.agents) config.agents = {};
let mainAgent;
if (
  config.agents.entries &&
  typeof config.agents.entries === "object" &&
  !Array.isArray(config.agents.entries)
) {
  // OpenClaw ≥2026.8.1: writing agents.list into an entries roster fails the strict schema.
  mainAgent = config.agents.entries.main;
  if (!mainAgent || typeof mainAgent !== "object") {
    mainAgent = {};
    config.agents.entries.main = mainAgent;
    configChanged = true;
  }
} else {
  // COMPAT(openclaw<2026.8.1): pre-entries array roster. Drop this branch (and
  // never create `agents.list`) when no install still uses list — see src/agent-roster.ts.
  if (!Array.isArray(config.agents.list)) config.agents.list = [];
  mainAgent = config.agents.list.find((a) => a && a.id === "main");
  if (!mainAgent) {
    mainAgent = { id: "main" };
    config.agents.list.push(mainAgent);
    configChanged = true;
  }
}
if (!mainAgent.tools) mainAgent.tools = {};
if (!Array.isArray(mainAgent.tools.alsoAllow)) mainAgent.tools.alsoAllow = [];
for (const tool of [
  "fridaynext_health_query",
  "fridaynext_health_log",
  "fridaynext_location_query",
]) {
  ensureArrayContains(mainAgent.tools.alsoAllow, tool);
}
if (Array.isArray(mainAgent.tools.deny)) {
  for (const tool of [
    "canvas",
    "nodes",
    "fridaynext_health_query",
    "fridaynext_health_log",
    "fridaynext_location_query",
  ]) {
    const idx = mainAgent.tools.deny.indexOf(tool);
    if (idx !== -1) {
      mainAgent.tools.deny.splice(idx, 1);
      configChanged = true;
    }
  }
}

// —— FridayTunnel standby ——
//
// Standby is now the plugin default on every dist-tag. It registers only a pseudonymous gateway
// key and waits for entitlement; it does NOT spawn frpc or expose a public port. Therefore the
// installer no longer writes an `enabled` product state. Existing explicit `enabled:false` stays
// honored as a legacy operator hard stop; new zero-egress setups should use standbyDisabled=true.
const publicAccessConfig = config.channels["friday-next"].publicAccess ?? {};
const enabledPublicAccess =
  publicAccessConfig.enabled !== false && publicAccessConfig.standbyDisabled !== true;

if (configChanged) {
  try {
    writeFileSync(OPENCLAW_CONFIG, JSON.stringify(config, null, 2) + "\n", "utf8");
    configStep.ok(T.detailUpdated);
  } catch {
    configStep.fail();
    die(T.failWriteConfig(OPENCLAW_CONFIG));
  }
} else {
  configStep.ok(T.detailUnchanged);
}

// --------------- restart gateway ---------------

const restartStep = ui.step(T.stepRestart);
restartStep.detail(T.detailRestartHint);
// True when `gateway restart` reported there is no managed service to restart (containers,
// hosts without systemd/launchd). The plugin install itself succeeded in that case — only the
// gateway process needs a manual foreground start — so a later verify timeout must say THAT
// instead of the misleading "Installation FAILED".
let gatewayServiceUnavailable = false;
const SERVICE_UNAVAILABLE_RE =
  /service disabled|systemd user services are unavailable|run the gateway in the foreground/i;
try {
  // A full gateway restart commonly takes 20s+ on a fresh boot; give it plenty of room
  // so we don't kill it mid-restart and report a false failure.
  const restartOut = execSync(`${openclawCmd} gateway restart`, {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 90000,
  });
  // The core exits 0 while explaining there is no service — read what it said.
  gatewayServiceUnavailable = SERVICE_UNAVAILABLE_RE.test(restartOut ?? "");
  restartStep.ok(gatewayServiceUnavailable ? T.detailRestartNoService : "");
} catch (e) {
  gatewayServiceUnavailable = SERVICE_UNAVAILABLE_RE.test(`${e.stdout ?? ""}\n${e.stderr ?? ""}`);
  if (gatewayServiceUnavailable) {
    restartStep.ok(T.detailRestartNoService);
  } else {
    // ETIMEDOUT/SIGTERM here usually means the restart is simply slow, not broken —
    // the verify step below is the real gate either way, so never fail hard here.
    const slow = e.code === "ETIMEDOUT" || e.signal === "SIGTERM";
    restartStep.ok(slow ? T.detailRestartSlow : T.detailRestartUnconfirmed);
  }
}

// --------------- verify ---------------

// Interfaces whose address other LAN machines cannot reach (container bridges, VM adapters,
// VPN tunnels). Advertising one of those as the gateway URL bricks pairing — the app tries
// only the LAN address for the voucher exchange. Must stay in lockstep with frpc-manager.ts.
const VIRTUAL_IFACE_NAME =
  /^(docker|br-|bridge|virbr|veth|vmenet|vnic|utun|tun|tap|tailscale|zt|wg|anpi|llw|awdl|feth)/i;

async function getLanIp() {
  // Preferred: kernel routing-table query. UDP connect() binds the source address the default
  // route would use without sending any packet — correct on multi-NIC hosts, works offline
  // and behind CGNAT. 223.5.5.5 (AliDNS) keeps even an escalated query routable in mainland
  // China. Fallback: interface enumeration with virtual adapters filtered out.
  const routed = await new Promise((resolve) => {
    try {
      const socket = dgramCreateSocket("udp4");
      const done = (ip) => {
        socket.close();
        resolve(ip && ip !== "0.0.0.0" ? ip : null);
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
      resolve(null);
    }
  });
  if (routed) return routed;

  const nets = networkInterfaces();
  let firstNonInternal = null;
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family !== "IPv4" || net.internal) continue;
      firstNonInternal ??= net.address;
      if (!VIRTUAL_IFACE_NAME.test(name)) return net.address;
    }
  }
  return firstNonInternal ?? "127.0.0.1";
}

try {
  config = JSON.parse(readFileSync(OPENCLAW_CONFIG, "utf8"));
} catch {
  config = {};
}

const gatewayPort = config.gateway?.port || 18789;
const gatewayToken = config.gateway?.auth?.token || "(not set)";
const bindMode = config.gateway?.bind || "localhost";

const gatewayUrl =
  bindMode === "lan"
    ? `http://${await getLanIp()}:${gatewayPort}`
    : `http://127.0.0.1:${gatewayPort}`;

// Always verify against loopback: the gateway binds 0.0.0.0 so it's reachable here,
// and this avoids false negatives from LAN/NAT routing of the advertised IP.
const verifyUrl = `http://127.0.0.1:${gatewayPort}`;

async function verifyGateway(url, token, retries = 30) {
  const http = await import("node:http");
  const { hostname, port } = new URL(url);
  for (let i = 1; i <= retries; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname,
            port,
            path: "/friday-next/status",
            method: "GET",
            headers: { authorization: `Bearer ${token}` },
            timeout: 5000,
          },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode, body }));
          },
        );
        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("timeout"));
        });
        req.end();
      });
      if (res.status === 200) {
        try {
          const data = JSON.parse(res.body);
          if (data.ok) return { ok: true, version: data.version };
          return { ok: false, reason: T.reasonNotOk };
        } catch {
          verifyStep.detail(T.detailRetry(i, retries));
          continue;
        }
      }
      if (res.status === 401) return { ok: false, reason: T.reasonAuth };
      if (res.status === 404) return { ok: false, reason: T.reasonNotLoaded };
      verifyStep.detail(T.detailRetry(i, retries));
    } catch {
      verifyStep.detail(T.detailRetry(i, retries));
    }
  }
  return { ok: false, reason: T.reasonTimeout };
}

/** Start the gateway detached on native Windows, where the managed Scheduled Task start can
 * silently lose the process. Logs land in ~/.openclaw/gateway-installer.*.log so a failure
 * here is diagnosable after the installer exits. */
function selfStartGatewayWindows() {
  try {
    const logDir = join(USER_HOME, ".openclaw");
    const out = openSync(join(logDir, "gateway-installer.out.log"), "a");
    const err = openSync(join(logDir, "gateway-installer.err.log"), "a");
    // shell:true → cmd.exe resolves openclaw.cmd from PATH; detached so the gateway outlives
    // both this installer and the console it was launched from.
    const child = spawn("openclaw gateway run", {
      shell: true,
      detached: true,
      stdio: ["ignore", out, err],
      windowsHide: true,
    });
    child.unref();
  } catch {
    /* the verify loop below reports the truth either way */
  }
}

const verifyStep = ui.step(T.stepVerify);
// Native Windows: the managed restart can report success while the Scheduled-Task-spawned
// gateway dies silently in session 0 (observed 2026-08-29 on a Parallels VM — the installer
// then burned the whole verify window on a port nobody owned). Probe briefly; if nobody
// answers, start the gateway detached ourselves and let the full verify below decide.
if (process.platform === "win32") {
  const quick = await verifyGateway(verifyUrl, gatewayToken, 3);
  if (!quick.ok) {
    selfStartGatewayWindows();
    restartStep.detail(T.detailRestartSelfStart);
  }
}
// No managed service → nobody is going to start the gateway for us; a running foreground
// gateway answers on the first few probes, so don't sit through the full 30s timeout.
const verified = await verifyGateway(verifyUrl, gatewayToken, gatewayServiceUnavailable ? 5 : 30);

// Hard gate: if the gateway didn't verify, the install did NOT succeed — stop here
// with a non-zero exit and never print the QR block, so a failure can't look like
// a success.
if (!verified.ok) {
  verifyStep.fail(verified.reason);
  // Containers / hosts without systemd: the plugin IS installed and configured; only the
  // gateway process isn't running (and can't be, as a service). Saying "Installation FAILED"
  // here sends the user chasing a phantom install problem — tell them the one real next step.
  if (gatewayServiceUnavailable) {
    die(T.failGatewayNoService, "openclaw gateway run", RERUN_CMD);
  }
  die(T.failGateway, "openclaw gateway status", "openclaw gateway restart", RERUN_CMD);
}
verifyStep.ok(verified.version ? `friday-next ${verified.version}` : "");

// --------------- QR code ---------------

// GET the public-access pairing superset from the just-verified gateway. Returns
// the parsed object (`{v, lanUrl, publicUrl, fingerprint, token, ...}`) or null
// when public access is off / the tunnel isn't up (503) / any error.
async function fetchPairingSuperset(url, token) {
  const http = await import("node:http");
  const { hostname, port } = new URL(url);
  try {
    return await new Promise((resolve) => {
      const req = http.request(
        {
          hostname,
          port,
          path: "/friday-next/public-access/pairing",
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
          timeout: 5000,
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            if (res.statusCode !== 200) return resolve(null);
            try {
              resolve(JSON.parse(body));
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    });
  } catch {
    return null;
  }
}

// Five minutes covers a full slow certificate-signing attempt, the manager's 30s retry delay,
// and another attempt, while still returning immediately as soon as pairing coordinates exist.
const PAIRING_WAIT_TIMEOUT_MS = 5 * 60_000;
const PAIRING_POLL_INTERVAL_MS = 3_000;

// Default QR: legacy `{url, token}` — what stable installs emit. The beta channel
// upgrades it to the public-access superset so a scan also arms remote access.
let qrFields = { url: gatewayUrl, token: gatewayToken };
if (DIST_TAG === "beta") {
  // Identity preparation can include a first-time certificate issuance. That normally finishes
  // quickly, but the signer itself allows up to 130s and transient failures are retried after 30s.
  // Poll conservatively so a healthy first install is not mislabeled as LAN-only just because
  // certificate issuance was slow.
  const pairing = enabledPublicAccess
    ? await pollPairingSuperset(verifyUrl, gatewayToken)
    : await fetchPairingSuperset(verifyUrl, gatewayToken);
  if (pairing && pairing.publicUrl && pairing.pairingTicket) {
    // D12: the QR carries a 10-minute one-time pairing voucher, never the permanent
    // token — a leaked/photographed QR is worthless after one claim or 10 minutes, and
    // re-running install (or refetching the pairing) invalidates any outstanding QR.
    // The app exchanges it via POST /friday-next/pair/claim inside the pinned TLS
    // channel. No token fallback: the install gate above guarantees the running plugin
    // is the freshly-installed version, which always mints vouchers (and its pairing
    // response no longer contains the token at all).
    qrFields = {
      v: 2,
      lanUrl: pairing.lanUrl || gatewayUrl,
      publicUrl: pairing.publicUrl,
      fingerprint: pairing.fingerprint,
      pairingTicket: pairing.pairingTicket,
    };
  } else {
    ui.note(enabledPublicAccess ? T.noteTunnelTimeout : T.noteLanOnly);
  }
}

/** Retry the pairing fetch while a freshly-enabled FridayTunnel identity is prepared. */
async function pollPairingSuperset(url, token) {
  const step = ui.step(T.stepTunnel);
  step.detail(T.detailTunnelWait);
  const deadline = Date.now() + PAIRING_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const pairing = await fetchPairingSuperset(url, token);
    if (pairing?.publicUrl && pairing?.pairingTicket) {
      step.ok();
      return pairing;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await new Promise((r) => setTimeout(r, Math.min(PAIRING_POLL_INTERVAL_MS, remaining)));
    }
  }
  step.fail();
  return null;
}

// Encrypt the QR payload into the `FNQR1:` envelope so a generic QR reader shows
// only ciphertext — the public relay domain never appears in plaintext, and the
// pairing code is only useful inside the FridayNext app (which holds the key and
// decodes it in PairingQRCrypto.swift). OBFUSCATION-GRADE: this repo is open source,
// so the key below is discoverable; the real access control is App Attest + the
// relay's server-side authorization gate, NOT this. Its sole job is keeping the
// domain out of casual/plaintext view. AES-256-GCM, random 12-byte IV, layout
// iv(12) ‖ ciphertext ‖ tag(16), base64url. Must stay in lockstep with the app.
const QR_OBFUSCATION_KEY = Buffer.from("+ZxgpPIzbKu75GRrb1sjlS2Snoo0TSwePXDzQ2N75PY=", "base64");

// ——— FNQR2: binary body instead of JSON ———
//
// JSON + hex made the code needlessly dense: ~235 plaintext chars → a 357-char
// envelope → 67×34 terminal cells, which wraps on an 80-column window and is
// awkward to scan. The fields are mostly raw bytes wearing text costumes (a
// 64-char hex fingerprint = 32 bytes, a 32-char hex voucher = 16, an IPv4:port =
// 6, a public URL that is a constant suffix plus a short subdomain), so FNQR2
// packs them as bytes: 71 plaintext bytes → 47×24 cells, ~half the QR area.
// Layout: version byte 0x02, then `tag(1) len(1) value` records.
//
// Every field has a compact tag AND a plain-string tag; the compact one is used only
// when the value actually matches its shape, so an unusual LAN address or a
// self-hosted relay domain degrades to the string form instead of breaking.
// The relay's wildcard tunnel base (frps `subDomainHost`), NOT the control plane —
// public URLs are `https://<sub>.bj.gw.syengup.host`. Must match PairingQRCrypto.swift.
// A relay on any other base degrades to the full-URL record.
const QR_PUBLIC_SUFFIX = ".bj.gw.syengup.host";
const QR_TAG = {
  lanV4: 0x01, // ip(4) ‖ port(2, BE), scheme http
  lanUrl: 0x02,
  subdomain: 0x03, // publicUrl = https://<value><QR_PUBLIC_SUFFIX>
  publicUrl: 0x04,
  fingerprintRaw: 0x05, // 32 bytes → 64-char lowercase hex
  fingerprintStr: 0x06,
  voucherRaw: 0x07, // 16 bytes → "fnpv1-" ‖ hex
  pairingTicket: 0x08,
  token: 0x09,
  controlPlane: 0x0a,
  reservationId: 0x0b,
};

/** Pack the pairing fields into the FNQR2 binary body. */
function packQRFields(f) {
  const recs = [];
  const put = (tag, buf) => {
    if (buf.length > 255) throw new Error(`FNQR2 field ${tag} too long`);
    recs.push(Buffer.from([tag, buf.length]), buf);
  };
  const putStr = (tag, s) => put(tag, Buffer.from(s, "utf8"));

  const lan = f.lanUrl || f.url;
  if (lan) {
    const m = /^http:\/\/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})\/?$/.exec(lan);
    const octets = m ? m.slice(1, 5).map(Number) : null;
    const port = m ? Number(m[5]) : 0;
    if (octets && octets.every((o) => o <= 255) && port >= 1 && port <= 65535) {
      const b = Buffer.alloc(6);
      octets.forEach((o, i) => (b[i] = o));
      b.writeUInt16BE(port, 4);
      put(QR_TAG.lanV4, b);
    } else {
      putStr(QR_TAG.lanUrl, lan);
    }
  }
  if (f.publicUrl) {
    const m = /^https:\/\/([^./]+)\.(.+?)\/?$/.exec(f.publicUrl);
    if (m && "." + m[2] === QR_PUBLIC_SUFFIX) putStr(QR_TAG.subdomain, m[1]);
    else putStr(QR_TAG.publicUrl, f.publicUrl);
  }
  if (f.fingerprint) {
    if (/^[0-9a-f]{64}$/.test(f.fingerprint))
      put(QR_TAG.fingerprintRaw, Buffer.from(f.fingerprint, "hex"));
    else putStr(QR_TAG.fingerprintStr, f.fingerprint);
  }
  if (f.pairingTicket) {
    const m = /^fnpv1-([0-9a-f]{32})$/.exec(f.pairingTicket);
    if (m) put(QR_TAG.voucherRaw, Buffer.from(m[1], "hex"));
    else putStr(QR_TAG.pairingTicket, f.pairingTicket);
  }
  if (f.token) putStr(QR_TAG.token, f.token);
  if (f.controlPlane) putStr(QR_TAG.controlPlane, f.controlPlane);
  if (f.reservationId) putStr(QR_TAG.reservationId, f.reservationId);
  return Buffer.concat([Buffer.from([0x02]), ...recs]);
}

async function encryptQRPayload(body) {
  const { createCipheriv, randomBytes } = await import("node:crypto");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", QR_OBFUSCATION_KEY, iv);
  const ct = Buffer.concat([cipher.update(body), cipher.final()]);
  const tag = cipher.getAuthTag();
  return "FNQR2:" + Buffer.concat([iv, ct, tag]).toString("base64url");
}

// Fall back to the plaintext JSON only if packing/crypto is somehow unavailable (very
// old Node); the app parser still accepts plaintext for backward compatibility.
let qrData = JSON.stringify(qrFields);
try {
  qrData = await encryptQRPayload(packQRFields(qrFields));
} catch {
  /* keep the plaintext JSON */
}

let qr = "";
try {
  const { createRequire } = await import("node:module");
  const qrcode = createRequire(import.meta.url)("qrcode-terminal");
  qrcode.generate(qrData, { small: true }, (rendered) => (qr = rendered));
} catch {
  // qrcode-terminal unavailable — the URL/token below are still enough to pair by hand.
}

// The QR is the pairing path — it carries the address plus (with public access on)
// a one-time voucher, so printing the long-term token alongside it is both noise and
// a credential needlessly left on screen. The URL/token pair stays only as the
// fallback for a terminal where the code could not be drawn at all.
ui.result(
  qr
    ? { qr, hint: T.scanToPair }
    : {
        hint: T.scanFallback,
        hintMuted: true,
        fields: [
          { label: T.labelAddress, value: gatewayUrl },
          { label: T.labelToken, value: gatewayToken },
        ],
      },
);
