#!/usr/bin/env bash

# Friday Next plugin installer — one-click setup for the friday-next channel
# Usage:
#   ./install.sh [plugin-dir]
#   curl -fsSL https://raw.githubusercontent.com/SyengUp/openclaw-fridaynext-channel/main/install.sh | bash

set -e

PLUGIN_DIR="${1:-$HOME/.openclaw/extensions/friday-channel-next}"
OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { printf "  %s\\n" "$1"; }
warn() { printf "  ${YELLOW}!${NC} %s\\n" "$1"; }
err()  { printf "  ${RED}X${NC} %s\\n" "$1" >&2; }

trap 'err "Install failed."' ERR

# Check prerequisites
for cmd in node git openclaw; do
  if ! command -v "$cmd" &>/dev/null; then
    err "$cmd is required but not found. Install it first."
    exit 1
  fi
done

# Auto-detect package manager (prefer pnpm, fall back to npm)
if command -v pnpm &>/dev/null; then
  PKG="pnpm"
elif command -v npm &>/dev/null; then
  PKG="npm"
else
  err "pnpm or npm is required but not found. Install one first."
  exit 1
fi

# Auto-detect best registry (if npmjs.org is unreachable, use npmmirror)
if curl -s --connect-timeout 3 https://registry.npmjs.org/ >/dev/null 2>&1; then
  REGISTRY=""
else
  warn "Default registry unreachable, using https://registry.npmmirror.com"
  REGISTRY="--registry=https://registry.npmmirror.com"
fi

if [ ! -f "$OPENCLAW_CONFIG" ]; then
  err "OpenClaw config not found at $OPENCLAW_CONFIG"
  err "Make sure OpenClaw is installed and has been run at least once."
  exit 1
fi

# Step 1: Clone (if needed), install deps, and build

if [ -d "$PLUGIN_DIR" ]; then
  log "Plugin directory found: $PLUGIN_DIR"
else
  log "Cloning plugin to $PLUGIN_DIR ..."
  REPO_URL="${FRIDAY_NEXT_REPO:-https://github.com/SyengUp/openclaw-fridaynext-channel.git}"
  git clone "$REPO_URL" "$PLUGIN_DIR"
fi

cd "$PLUGIN_DIR"

log "Installing dependencies..."
$PKG install $REGISTRY

log "Building TypeScript..."
$PKG run build

# Step 2: Configure OpenClaw

log "Configuring OpenClaw..."

node --input-type=module -e '
import fs from "node:fs";

const configPath = process.argv[1];
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

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

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
console.log("  Config updated.");
' "$OPENCLAW_CONFIG"

# Step 3: Restart gateway

log "Restarting OpenClaw gateway..."
openclaw gateway restart

# Verify gateway is up
log "Verifying gateway..."
VERIFY_LOG=$(mktemp)
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import http from "node:http";

const config = JSON.parse(readFileSync(process.argv[1], "utf8"));

function getLanIp() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

const port = config.gateway?.port || 18789;
const token = config.gateway?.auth?.token || "";
const bind = config.gateway?.bind || "localhost";
const host = bind === "lan" ? getLanIp() : "127.0.0.1";

let ok = false;
async function verifyGateway() {
  for (let i = 1; i <= 6; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.request(
          { hostname: host, port, path: "/friday-next/status", method: "GET",
            headers: { authorization: "Bearer " + token }, timeout: 5000 },
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
            console.log("  Gateway verified OK (friday-next " + data.version + ", " + data.connections + " connections).");
            ok = true;
            return;
          }
          console.log("  ! Plugin responded but ok=false — " + JSON.stringify(data));
          return;
        } catch {
          if (i < 3) {
            console.log("  ! Plugin routes not registered yet, retrying (" + i + "/6)...");
          } else if (i < 6) {
            console.log("  ! Gateway is up but plugin routes missing — may need config reload, retrying (" + i + "/6)...");
          } else {
            console.log("  ! Gateway is running but plugin routes were not loaded. Check plugin config in openclaw.json.");
          }
          continue;
        }
      }
      if (res.status === 401) {
        console.log("  ! Auth token mismatch — check gateway.auth.token in openclaw.json.");
        return;
      }
      if (res.status === 404) {
        console.log("  ! Route /friday-next/status not found — plugin may not be loaded.");
        return;
      }
      if (i < 6) console.log("  ! Gateway responded " + res.status + ", retrying (" + i + "/6)...");
    } catch {
      if (i < 6) console.log("  ! Gateway not reachable, retrying (" + i + "/6)...");
    }
  }
  console.log("  ! Gateway verification timed out — check '\''openclaw gateway status'\'' manually.");
}
await verifyGateway();
console.log(ok ? "VERIFY_OK" : "VERIFY_FAIL");
' "$OPENCLAW_CONFIG" 2>&1 | tee "$VERIFY_LOG"
if grep -q "VERIFY_OK" "$VERIFY_LOG"; then
  VERIFY_PASS=1
else
  VERIFY_PASS=0
fi
rm -f "$VERIFY_LOG"

# Show connection info
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";

const config = JSON.parse(readFileSync(process.argv[1], "utf8"));

function getLanIp() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

const port = config.gateway?.port || 18789;
const token = config.gateway?.auth?.token || "(not set)";
const bind = config.gateway?.bind || "localhost";
const host = bind === "lan" ? getLanIp() : "127.0.0.1";

const YB = "\x1b[1;33m", N = "\x1b[0m";
const qrPayload = JSON.stringify({ url: "http://" + host + ":" + port, token: token });
let qrShown = false;
try {
  const { createRequire } = await import("node:module");
  const qrcode = createRequire(import.meta.url)("qrcode-terminal");
  console.log("");
  console.log(YB + "Scan below to auto-fill URL & Token in FridayNext app:" + N);
  console.log(YB + "扫描下方二维码自动填入 URL 和 Token：" + N);
  console.log("");
  qrcode.generate(qrPayload, { small: true });
  console.log("");
  console.log("If QR scan does not work, enter manually:");
  console.log("若二维码无法使用，请手动输入：");
  qrShown = true;
} catch {}
if (!qrShown) {
  console.log("");
  console.log(YB + "Input the URL and Token below into your FridayNext app to connect." + N);
  console.log(YB + "请将下方 URL 和 Token 输入至 FridayNext App 完成连接。" + N);
}
console.log("");
console.log("Gateway URL:  " + YB + "http://" + host + ":" + port + N);
console.log("Bearer Token: " + YB + token + N);
console.log("");
function classifyIp(ip) {
  var p = ip.split(".").map(Number);
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return "tailscale";
  if (p[0] === 127) return "loopback";
  if (p[0] === 10) return "private";
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return "private";
  if (p[0] === 192 && p[1] === 168) return "private";
  if (p[0] === 169 && p[1] === 254) return "private";
  return "public";
}
if (classifyIp(host) === "tailscale") {
  console.log("This is a Tailscale network URL (" + host + ").");
  console.log("Accessible from your Tailnet devices.");
} else if (classifyIp(host) === "private") {
  console.log("This is a LOCAL network URL (" + host + ", bind=" + bind + ").");
  console.log("If you need public access, configure HTTPS, Tailscale, or a reverse proxy.");
} else if (classifyIp(host) === "loopback") {
  console.log("This is a LOOPBACK URL (" + host + ").");
  console.log("Only accessible from this machine.");
} else {
  console.log("This URL appears to be publicly accessible (" + host + ").");
}
' "$OPENCLAW_CONFIG"

log "--------------------------------------------------"
if [ "$VERIFY_PASS" = "1" ]; then
  log "Installation complete! Friday Next channel is now active."
else
  warn "Installation complete, but gateway verification failed."
  warn "Check 'openclaw gateway status' and restart the gateway if needed."
  warn "Also ensure OpenClaw is updated to 2026.5.7 or above: openclaw update"
  warn "同时请确认 OpenClaw 已升级至 2026.5.7 或以上版本：openclaw update"
fi
log "--------------------------------------------------"
