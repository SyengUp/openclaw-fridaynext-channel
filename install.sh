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

log()  { printf "%b%s\\n" "${GREEN}[friday-next]${NC} " "$1"; }
warn() { printf "%b%s\\n" "${YELLOW}[friday-next]${NC} " "$1"; }
err()  { printf "%b%s\\n" "${RED}[friday-next]${NC} " "$1" >&2; }

trap 'err "Install failed."' ERR

# Check prerequisites
for cmd in pnpm node git openclaw; do
  if ! command -v "$cmd" &>/dev/null; then
    err "$cmd is required but not found. Install it first."
    exit 1
  fi
done

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
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

log "Building TypeScript..."
pnpm build

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

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
console.log("  Config updated.");
' "$OPENCLAW_CONFIG"

# Step 3: Restart gateway

log "Restarting OpenClaw gateway..."
openclaw gateway restart

log "--------------------------------------------------"
log "Installation complete! Friday Next channel is now active."
log ""
log "The channel uses your gateway auth token by default."
log "To use a different token, set FRIDAY_NEXT_AUTH_TOKEN env var or"
log "add authToken to channels.friday-next in openclaw.json."
log "--------------------------------------------------"
