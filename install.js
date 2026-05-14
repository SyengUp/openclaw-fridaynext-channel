#!/usr/bin/env node
import { execSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const sudoUser = process.env.SUDO_USER;

function realHome() {
  if (!sudoUser) return homedir();
  // Under sudo, homedir() may return /root. Check if HOME was preserved.
  const current = homedir();
  if (current !== "/root" && current !== "/var/root" && existsSync(current)) return current;
  // Resolve the real user's home
  try {
    const h = execSync(`sh -c 'echo ~${sudoUser}'`, { encoding: "utf8" }).trim();
    if (h && !h.startsWith("~") && existsSync(h)) return h;
  } catch {}
  for (const g of [`/home/${sudoUser}`, `/Users/${sudoUser}`]) {
    if (existsSync(g)) return g;
  }
  return current;
}

const USER_HOME = realHome();
const PLUGIN_DIR = process.argv[2] || join(USER_HOME, ".openclaw", "extensions", "friday-channel-next");
const OPENCLAW_CONFIG = join(USER_HOME, ".openclaw", "openclaw.json");
const REPO_URL = process.env.FRIDAY_NEXT_REPO || "https://github.com/SyengUp/openclaw-fridaynext-channel.git";

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
  // Under sudo, openclaw isn't in root's PATH — run via the real user.
  try {
    execSync(`sudo -u "${sudoUser}" openclaw --version`, { stdio: "ignore" });
    openclawCmd = `sudo -u "${sudoUser}" openclaw`;
    return true;
  } catch {}
  return false;
}

// Running from an npm/npx package when we have the full source (index.ts + package.json)
// and are NOT already inside the target plugin dir.
function isRunningFromNpmPackage() {
  return (
    resolve(__dirname) !== resolve(PLUGIN_DIR) &&
    existsSync(join(__dirname, "package.json")) &&
    existsSync(join(__dirname, "index.ts"))
  );
}

// --------------- prerequisites ---------------

if (sudoUser) {
  warn("Running under sudo is unnecessary and may cause issues.");
  warn("If possible, run without sudo: npx -y @syengup/friday-channel-next");
}

const missing = [];
if (!has("node")) missing.push("node");
if (!hasOpenclaw()) missing.push("openclaw");
if (missing.length) {
  missing.forEach((c) => err(`${c} is required but not found. Install it first.`));
  if (sudoUser && missing.includes("openclaw")) {
    err("Could not find openclaw even via the real user's PATH.");
    err(`Check that openclaw is installed under ${USER_HOME}.`);
  }
  process.exit(1);
}

const PKG = has("pnpm") ? "pnpm" : has("npm") ? "npm" : null;
if (!PKG) {
  err("pnpm or npm is required but not found. Install one first.");
  process.exit(1);
}

// Auto-detect best registry (measure latency; fall back to npmmirror if slow/unreachable)
let registryFlag = "";
try {
  const start = Date.now();
  execSync('curl -s -o /dev/null --connect-timeout 2 --max-time 4 https://registry.npmjs.org/', { stdio: "pipe", timeout: 6000 });
  if (Date.now() - start > 1500) {
    warn("Default registry slow, using https://registry.npmmirror.com");
    registryFlag = "--registry=https://registry.npmmirror.com";
  }
} catch {
  warn("Default registry unreachable, using https://registry.npmmirror.com");
  registryFlag = "--registry=https://registry.npmmirror.com";
}

if (!existsSync(OPENCLAW_CONFIG)) {
  err(`OpenClaw config not found at ${OPENCLAW_CONFIG}`);
  err("Make sure OpenClaw is installed and has been run at least once.");
  process.exit(1);
}

// --------------- acquire source ---------------

if (existsSync(PLUGIN_DIR)) {
  log(`Plugin directory found: ${PLUGIN_DIR}`);
} else if (isRunningFromNpmPackage()) {
  log(`Copying plugin from npm package to ${PLUGIN_DIR} ...`);
  cpSync(__dirname, PLUGIN_DIR, {
    recursive: true,
    filter: (src) => {
      const rel = relative(__dirname, src);
      if (rel === "") return true; // root dir
      const top = rel.split(sep)[0];
      return ![".git", "node_modules", "dist", "attachments", ".claude"].includes(top);
    },
  });
} else {
  if (!has("git")) {
    err("git is required for installation from GitHub. Install git first or use npx @openclaw/friday-channel-next.");
    process.exit(1);
  }
  log(`Cloning plugin to ${PLUGIN_DIR} ...`);
  execSync(`git clone "${REPO_URL}" "${PLUGIN_DIR}"`, { stdio: "inherit" });
}

process.chdir(PLUGIN_DIR);

// --------------- install + build ---------------

log("Installing dependencies...");
try {
  execSync(`${PKG} install ${registryFlag}`, { stdio: "inherit" });
} catch {
  err("Dependency installation failed.");
  err("Check your network connection and try again.");
  if (sudoUser) err("If running under sudo, ensure the real user can access the package manager.");
  process.exit(1);
}

log("Building TypeScript...");
try {
  execSync(`${PKG} run build`, { stdio: "inherit" });
} catch {
  err("TypeScript build failed.");
  err("Check the compilation errors above and make sure the package is not corrupted.");
  process.exit(1);
}

// --------------- configure OpenClaw ---------------

log("Configuring OpenClaw...");

let config;
try {
  config = JSON.parse(readFileSync(OPENCLAW_CONFIG, "utf8"));
} catch {
  err(`Failed to read ${OPENCLAW_CONFIG}.`);
  err("The file may be missing or corrupted. Verify OpenClaw is installed correctly.");
  process.exit(1);
}

if (!config.plugins) config.plugins = {};
if (!Array.isArray(config.plugins.allow)) config.plugins.allow = [];
if (!config.plugins.allow.includes("friday-next")) {
  config.plugins.allow.push("friday-next");
  console.log("  + Added friday-next to plugins.allow");
}

if (!config.plugins.entries) config.plugins.entries = {};
if (!config.plugins.entries["friday-next"]) {
  config.plugins.entries["friday-next"] = { enabled: true };
  console.log("  + Added friday-next to plugins.entries (enabled)");
} else if (!config.plugins.entries["friday-next"].enabled) {
  config.plugins.entries["friday-next"].enabled = true;
  console.log("  + Enabled friday-next in plugins.entries");
}

if (!config.channels) config.channels = {};
if (!config.channels["friday-next"]) {
  config.channels["friday-next"] = { enabled: true, transport: "http+sse" };
  console.log("  + Added friday-next channel config (auth defaults to gateway token)");
} else {
  if (!config.channels["friday-next"].enabled) {
    config.channels["friday-next"].enabled = true;
    console.log("  + Enabled friday-next channel");
  }
  if (!config.channels["friday-next"].transport) {
    config.channels["friday-next"].transport = "http+sse";
    console.log("  + Set friday-next transport to http+sse");
  }
}

if (!config.gateway) config.gateway = {};
if (config.gateway.bind !== "lan") {
  config.gateway.bind = "lan";
  console.log("  + Set gateway.bind to lan");
}

try {
  writeFileSync(OPENCLAW_CONFIG, JSON.stringify(config, null, 2) + "\n", "utf8");
} catch {
  err(`Failed to write ${OPENCLAW_CONFIG}.`);
  err("Check disk space and file permissions.");
  process.exit(1);
}
console.log("  Config updated.");

if (sudoUser) {
  try {
    execSync(`chown -R "${sudoUser}" "${PLUGIN_DIR}" "${OPENCLAW_CONFIG}"`, { stdio: "ignore" });
    log("Fixed file ownership back to " + sudoUser);
  } catch {
    warn("Could not fix file ownership — files in " + PLUGIN_DIR + " may be owned by root.");
  }
}

// --------------- restart gateway ---------------

log("Restarting OpenClaw gateway...");
try {
  const out = execSync(`${openclawCmd} gateway restart`, { encoding: "utf8", stdio: "pipe" });
  if (out.trim()) console.log(out.trim());
} catch (e) {
  if (e.stdout?.trim()) console.log(e.stdout.trim());
  if (e.stderr?.trim()) console.error(e.stderr.trim());
  warn("Gateway restart failed. The plugin files are installed but the gateway was not restarted.");
  warn("Check 'openclaw gateway status' and restart manually: openclaw gateway restart");
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

const gatewayPort = config.gateway?.port || 18789;
const gatewayToken = config.gateway?.auth?.token || "(not set)";
const bindMode = config.gateway?.bind || "localhost";

const gatewayUrl = bindMode === "lan"
  ? `http://${getLanIp()}:${gatewayPort}`
  : `http://127.0.0.1:${gatewayPort}`;

async function verifyGateway(url, token, retries = 6) {
  const http = await import("node:http");
  const { hostname, port } = new URL(url);
  for (let i = 1; i <= retries; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.request(
          { hostname, port, path: "/friday-next/status", method: "GET",
            headers: { authorization: `Bearer ${token}` }, timeout: 5000 },
          (res) => { let body = ""; res.on("data", (c) => body += c); res.on("end", () => resolve({ status: res.statusCode, body })); },
        );
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.end();
      });
      if (res.status === 200) {
        try {
          const data = JSON.parse(res.body);
          if (data.ok) {
            log("Gateway verified OK (friday-next " + data.version + ", " + data.connections + " connections).");
            return true;
          }
          warn("Plugin responded but ok=false — " + JSON.stringify(data));
          return false;
        } catch {
          // body is not JSON (e.g. HTML control panel) — plugin route not registered yet
          if (i < 3) {
            warn(`Plugin routes not registered yet, retrying (${i}/${retries})...`);
          } else if (i < retries) {
            warn(`Gateway is up but plugin routes missing — may need config reload, retrying (${i}/${retries})...`);
          } else {
            warn("Gateway is running but plugin routes were not loaded. Check plugin config in openclaw.json.");
          }
          continue;
        }
      }
      if (res.status === 401) {
        warn("Auth token mismatch — check gateway.auth.token in openclaw.json.");
        return false;
      }
      if (res.status === 404) {
        warn("Route /friday-next/status not found — plugin may not be loaded.");
        return false;
      }
      if (i < retries) warn(`Gateway responded ${res.status}, retrying (${i}/${retries})...`);
    } catch {
      // Connection refused / timeout — gateway not running yet
      if (i < retries) warn(`Gateway not reachable, retrying (${i}/${retries})...`);
    }
  }
  warn("Gateway verification timed out — check 'openclaw gateway status' manually.");
  return false;
}

log("Verifying gateway...");
const verified = await verifyGateway(gatewayUrl, gatewayToken);

// --------------- show connection info ---------------

const BOLD_YELLOW = (s) => `\x1b[1;33m${s}\x1b[0m`;

log("--------------------------------------------------");
if (verified) {
  log("Installation complete! Friday Next channel is now active.");
} else {
  warn("Installation complete, but gateway verification failed.");
  warn("Check 'openclaw gateway status' and restart the gateway if needed.");
  warn("Also ensure OpenClaw is updated to 2026.5.7 or above: openclaw update");
  warn("同时请确认 OpenClaw 已升级至 2026.5.7 或以上版本：openclaw update");
}
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
} catch {
  // qrcode-terminal not available, fall through to manual-only
}

// --------------- manual input ---------------

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
  log("Accessible from your Tailnet devices.");
} else if (ipType === "private") {
  log("This is a LOCAL network URL (" + ip + ", bind=" + bindMode + ").");
  log("If you need public access, configure HTTPS, Tailscale, or a reverse proxy.");
} else if (ipType === "loopback") {
  log("This is a LOOPBACK URL (" + ip + ").");
  log("Only accessible from this machine.");
} else {
  log("This URL appears to be publicly accessible (" + ip + ").");
}
log("--------------------------------------------------");
