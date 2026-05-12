#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_DIR = process.argv[2] || join(homedir(), ".openclaw", "extensions", "friday-channel-next");
const OPENCLAW_CONFIG = join(homedir(), ".openclaw", "openclaw.json");
const REPO_URL = process.env.FRIDAY_NEXT_REPO || "https://github.com/SyengUp/openclaw-fridaynext-channel.git";

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;

function log(msg) {
  console.log(`${G("[friday-next]")} ${msg}`);
}
function warn(msg) {
  console.log(`${Y("[friday-next]")} ${msg}`);
}
function err(msg) {
  console.error(`${R("[friday-next]")} ${msg}`);
}

function has(cmd) {
  try {
    execSync(`${cmd} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// --------------- prerequisites ---------------

const missing = ["pnpm", "node", "git", "openclaw"].filter((c) => !has(c));
if (missing.length) {
  missing.forEach((c) => err(`${c} is required but not found. Install it first.`));
  process.exit(1);
}

if (!existsSync(OPENCLAW_CONFIG)) {
  err(`OpenClaw config not found at ${OPENCLAW_CONFIG}`);
  err("Make sure OpenClaw is installed and has been run at least once.");
  process.exit(1);
}

// --------------- clone / update ---------------

if (existsSync(PLUGIN_DIR)) {
  log(`Plugin directory found: ${PLUGIN_DIR}`);
} else {
  log(`Cloning plugin to ${PLUGIN_DIR} ...`);
  execSync(`git clone "${REPO_URL}" "${PLUGIN_DIR}"`, { stdio: "inherit" });
}

process.chdir(PLUGIN_DIR);

// --------------- install + build ---------------

log("Installing dependencies...");
try {
  execSync("pnpm install --frozen-lockfile", { stdio: "inherit" });
} catch {
  execSync("pnpm install", { stdio: "inherit" });
}

log("Building TypeScript...");
execSync("pnpm build", { stdio: "inherit" });

// --------------- configure OpenClaw ---------------

log("Configuring OpenClaw...");

const config = JSON.parse(readFileSync(OPENCLAW_CONFIG, "utf8"));

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

writeFileSync(OPENCLAW_CONFIG, JSON.stringify(config, null, 2) + "\n", "utf8");
console.log("  Config updated.");

// --------------- restart gateway ---------------

log("Restarting OpenClaw gateway...");
execSync("openclaw gateway restart", { stdio: "inherit" });

log("--------------------------------------------------");
log("Installation complete! Friday Next channel is now active.");
log("");
log("The channel uses your gateway auth token by default.");
log("To use a different token, set FRIDAY_NEXT_AUTH_TOKEN env var or");
log("add authToken to channels.friday-next in openclaw.json.");
log("--------------------------------------------------");
