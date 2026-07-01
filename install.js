#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";

const sudoUser = process.env.SUDO_USER;

function realHome() {
  if (!sudoUser) return homedir();
  const current = homedir();
  if (current !== "/root" && current !== "/var/root" && existsSync(current)) return current;
  try {
    const h = execSync(`sh -c 'echo ~${sudoUser}'`, { encoding: "utf8" }).trim();
    if (h && !h.startsWith("~") && existsSync(h)) return h;
  } catch {}
  for (const g of [`/home/${sudoUser}`, `/Users/${sudoUser}`, `C:\\Users\\${sudoUser}`]) {
    if (existsSync(g)) return g;
  }
  return current;
}

const USER_HOME = realHome();
const OPENCLAW_CONFIG = join(USER_HOME, ".openclaw", "openclaw.json");

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
function log(msg) {
  console.log(`  ${msg}`);
}
function warn(msg) {
  console.log(`  ${Y("!")} ${msg}`);
}
function err(msg) {
  console.error(`  ${R("X")} ${msg}`);
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

if (sudoUser) {
  warn("Running under sudo is unnecessary and may cause issues.");
  warn("If possible, run without sudo: npx -y @syengup/friday-channel-next");
}

if (!has("node")) {
  err("node is required but not found. Install it first.");
  process.exit(1);
}
if (!hasOpenclaw()) {
  err("openclaw is required but not found. Install OpenClaw first: https://docs.openclaw.ai");
  process.exit(1);
}

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
      if (tooOld) {
        err(`OpenClaw version ${m[0]} is too old.`);
        err(`Friday Next channel requires OpenClaw 2026.5.12 or above.`);
        err(`Please update: ${openclawCmd} update`);
        process.exit(1);
      }
    }
  } catch {
    warn("Could not determine OpenClaw version — continuing anyway.");
  }
}

// --------------- install plugin package ---------------

const PKG = "@syengup/friday-channel-next";

// Resolve the EXACT latest version and install THAT — never the `@latest`
// dist-tag. OpenClaw persists a `@latest` install as a caret range
// (`"^1.0.5"`) in the managed project package.json, and OpenClaw's own plugin
// auto-update later rejects that range ("unsupported npm spec: use an exact
// version or dist-tag"), disabling the plugin. An exact version is stored as an
// exact spec, which auto-update accepts.
async function resolveLatestVersion() {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG}/latest`, {
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
  try {
    const v = execSync(`npm view ${PKG} version`, { encoding: "utf8", timeout: 20000 }).trim();
    if (/^\d+\.\d+\.\d+/.test(v)) return v;
  } catch {
    /* fall through */
  }
  return null;
}

log("Installing Friday Next channel plugin...");

const resolvedVersion = await resolveLatestVersion();
let installSpec;
if (resolvedVersion) {
  installSpec = `${PKG}@${resolvedVersion}`;
} else {
  // Registry lookup failed — fall back to @latest so a transient network hiccup
  // doesn't block the install. Re-running the installer later will pin an exact
  // spec once the registry is reachable.
  warn("Could not resolve exact latest version — falling back to @latest.");
  installSpec = `${PKG}@latest`;
}

try {
  const out = execSync(`${openclawCmd} plugins install ${installSpec} --force`, {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 120000,
  });
  if (out.trim()) console.log(out.trim());
  log("Plugin registered with install record — auto-upgrade enabled.");

  // Remove old manual install to avoid "duplicate plugin id" warning.
  const legacyDir = join(USER_HOME, ".openclaw", "extensions", "friday-channel-next");
  if (existsSync(legacyDir)) {
    try {
      rmSync(legacyDir, { recursive: true, force: true });
      log("Removed legacy manual install.");
    } catch {
      /* non-critical */
    }
  }
} catch (e) {
  const msg = (e.stderr || e.stdout || e.message || "").toString();
  err("Plugin install failed: " + (msg.trim().split("\n").pop() || "unknown error"));
  err("Fix the error above and re-run: npx -y @syengup/friday-channel-next");
  process.exit(1);
}

// --------------- configure OpenClaw ---------------

log("Configuring OpenClaw...");

let config;
try {
  config = JSON.parse(readFileSync(OPENCLAW_CONFIG, "utf8"));
} catch {
  err(`Failed to read ${OPENCLAW_CONFIG}.`);
  err("Make sure OpenClaw is installed and has been run at least once.");
  process.exit(1);
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

// Plugins
if (!config.plugins) config.plugins = {};
if (!Array.isArray(config.plugins.allow)) config.plugins.allow = [];
ensureArrayContains(config.plugins.allow, "friday-next");
ensureArrayContains(config.plugins.allow, "canvas");

if (!config.plugins.entries) config.plugins.entries = {};
for (const id of ["friday-next", "canvas"]) {
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

// Channel
if (!config.channels) config.channels = {};
if (!config.channels["friday-next"]) {
  config.channels["friday-next"] = { enabled: true, transport: "http+sse" };
  configChanged = true;
} else {
  if (!config.channels["friday-next"].enabled) {
    config.channels["friday-next"].enabled = true;
    configChanged = true;
  }
  if (!config.channels["friday-next"].transport) {
    config.channels["friday-next"].transport = "http+sse";
    configChanged = true;
  }
}

// Gateway bind + nodes
if (!config.gateway) config.gateway = {};
if (config.gateway.bind !== "lan") {
  config.gateway.bind = "lan";
  configChanged = true;
}
if (!config.gateway.nodes) config.gateway.nodes = {};
if (!Array.isArray(config.gateway.nodes.allowCommands)) config.gateway.nodes.allowCommands = [];
for (const cmd of [
  "canvas.navigate",
  "canvas.present",
  "canvas.hide",
  "canvas.eval",
  "canvas.snapshot",
  "canvas.a2ui.push",
  "canvas.a2ui.reset",
  "canvas.a2ui.pushJSONL",
]) {
  ensureArrayContains(config.gateway.nodes.allowCommands, cmd);
}

// Agent tools
if (!config.agents) config.agents = {};
if (!Array.isArray(config.agents.list)) config.agents.list = [];
let mainAgent = config.agents.list.find((a) => a.id === "main");
if (!mainAgent) {
  mainAgent = { id: "main" };
  config.agents.list.push(mainAgent);
  configChanged = true;
}
if (!mainAgent.tools) mainAgent.tools = {};
if (!Array.isArray(mainAgent.tools.alsoAllow)) mainAgent.tools.alsoAllow = [];
for (const tool of ["canvas", "nodes"]) {
  ensureArrayContains(mainAgent.tools.alsoAllow, tool);
}
if (Array.isArray(mainAgent.tools.deny)) {
  for (const tool of ["canvas", "nodes"]) {
    const idx = mainAgent.tools.deny.indexOf(tool);
    if (idx !== -1) {
      mainAgent.tools.deny.splice(idx, 1);
      configChanged = true;
    }
  }
}

if (configChanged) {
  try {
    writeFileSync(OPENCLAW_CONFIG, JSON.stringify(config, null, 2) + "\n", "utf8");
    log("openclaw.json updated.");
  } catch {
    err(`Failed to write ${OPENCLAW_CONFIG}.`);
    process.exit(1);
  }
} else {
  log("openclaw.json already configured.");
}

// --------------- restart gateway ---------------

log("Restarting OpenClaw gateway... (this can take 20-30s)");
try {
  // A full gateway restart commonly takes 20s+ on a fresh boot; give it plenty of room
  // so we don't kill it mid-restart and report a false failure.
  const out = execSync(`${openclawCmd} gateway restart`, {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 90000,
  });
  if (out.trim()) console.log(out.trim());
} catch (e) {
  if (e.stdout?.trim()) console.log(e.stdout.trim());
  if (e.stderr?.trim()) console.error(e.stderr.trim());
  // ETIMEDOUT/SIGTERM here usually means the restart is simply slow, not broken —
  // the verify step below will confirm whether the gateway actually came up.
  if (e.code === "ETIMEDOUT" || e.signal === "SIGTERM") {
    warn("Gateway restart is taking a while — will verify below.");
  } else {
    warn("Gateway restart failed. Restart manually: openclaw gateway restart");
  }
}

// --------------- verify ---------------

function getLanIp() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
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
  bindMode === "lan" ? `http://${getLanIp()}:${gatewayPort}` : `http://127.0.0.1:${gatewayPort}`;

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
          if (data.ok) {
            log(
              "Gateway verified OK (friday-next " +
                data.version +
                ", " +
                data.connections +
                " connections).",
            );
            return true;
          }
          warn("Plugin responded but ok=false — " + JSON.stringify(data));
          return false;
        } catch {
          if (i < retries) warn(`Plugin routes not registered yet, retrying (${i}/${retries})...`);
          continue;
        }
      }
      if (res.status === 401) {
        warn("Auth token mismatch — check gateway.auth.token.");
        return false;
      }
      if (res.status === 404) {
        warn("Route not found — plugin may not be loaded.");
        return false;
      }
      if (i < retries) warn(`Gateway responded ${res.status}, retrying (${i}/${retries})...`);
    } catch {
      if (i < retries) warn(`Gateway not reachable, retrying (${i}/${retries})...`);
    }
  }
  warn("Gateway verification timed out.");
  return false;
}

log("Verifying gateway...");
const verified = await verifyGateway(verifyUrl, gatewayToken);

const BOLD_YELLOW = (s) => `\x1b[1;33m${s}\x1b[0m`;

// Hard gate: if the gateway didn't verify, the install did NOT succeed — stop here
// with a non-zero exit and do NOT print the QR / URL / "complete" block, so a failure
// can never look like a success.
if (!verified) {
  log("--------------------------------------------------");
  err("Installation FAILED: the Friday Next gateway did not come up.");
  err("Diagnose with:  openclaw gateway status");
  err("Then restart:   openclaw gateway restart");
  err("And re-run:     npx -y @syengup/friday-channel-next");
  process.exit(1);
}

// --------------- show connection info ---------------

log("--------------------------------------------------");
log("Installation complete! Friday Next channel is now active.");
log("");

// --------------- QR code ---------------

const qrPayload = JSON.stringify({ url: gatewayUrl, token: gatewayToken });
let qrShown = false;

try {
  const { createRequire } = await import("node:module");
  const qrcode = createRequire(import.meta.url)("qrcode-terminal");
  log(BOLD_YELLOW("Scan below to auto-fill URL & Token in FridayNext app:"));
  log(BOLD_YELLOW("扫描下方二维码自动填入 URL 和 Token："));
  log("");
  qrcode.generate(qrPayload, { small: true });
  log("");
  log("If QR scan doesn't work, enter manually:");
  log("若二维码无法使用，请手动输入：");
  qrShown = true;
} catch {}

if (!qrShown) {
  log(BOLD_YELLOW("Input the URL and Token below into your FridayNext app to connect."));
  log(BOLD_YELLOW("请将下方 URL 和 Token 输入至 FridayNext App 完成连接。"));
}
log("");
log("Gateway URL:  " + BOLD_YELLOW(gatewayUrl));
log("Bearer Token: " + BOLD_YELLOW(gatewayToken));
log("");
function classifyIp(ip) {
  const p = ip.split(".").map(Number);
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return "tailscale";
  if (p[0] === 127) return "loopback";
  if (p[0] === 10) return "private";
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return "private";
  if (p[0] === 192 && p[1] === 168) return "private";
  if (p[0] === 169 && p[1] === 254) return "private";
  return "public";
}
const ip = new URL(gatewayUrl).hostname;
const ipType = classifyIp(ip);
if (ipType === "tailscale") {
  log("This is a Tailscale network URL (" + ip + ").");
} else if (ipType === "private") {
  log("This is a LOCAL network URL (" + ip + ", bind=" + bindMode + ").");
} else {
  log("This URL appears to be publicly accessible (" + ip + ").");
}

// The advertised IP is the local/NAT address, which a phone over the internet
// can't reach. Best-effort: detect the network's public-facing IP. NOTE: an echo
// service only reports the egress address — on a cloud VPS that's a routable 1:1
// NAT, but on a home/carrier-grade NAT (CGNAT) it's a shared egress IP that is
// NOT reachable inbound. So we present it as a hint, not a guarantee.
if (ipType === "private" || ipType === "loopback") {
  const publicIp = await detectPublicIp();
  if (publicIp && publicIp !== ip) {
    log("");
    log(BOLD_YELLOW("Network public-facing IP detected — for remote access try:"));
    log(BOLD_YELLOW("检测到网络出口公网 IP —— 远程连接可尝试："));
    log("Public URL:   " + BOLD_YELLOW(`http://${publicIp}:${gatewayPort}`));
    log("First open inbound TCP port " + gatewayPort + " in your firewall / cloud security group.");
    log("请先在防火墙 / 云安全组放行入站 TCP 端口 " + gatewayPort + "。");
    log("If this is a home/carrier network (CGNAT), this IP may NOT be reachable from outside —");
    log("use a tunnel like Tailscale instead.");
    log("若为家庭宽带 / 运营商大内网(CGNAT)，此地址可能无法从外部入站访问，");
    log("请改用 Tailscale 等内网穿透方案。");
  }
}
log("--------------------------------------------------");

async function detectPublicIp() {
  const endpoints = ["http://api.ipify.org", "http://ifconfig.me/ip", "http://icanhazip.com"];
  const http = await import("node:http");
  for (const url of endpoints) {
    try {
      const ipStr = await new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 3000 }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve(body.trim()));
        });
        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("timeout"));
        });
      });
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ipStr)) return ipStr;
    } catch {
      /* try next */
    }
  }
  return null;
}
