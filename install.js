#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { createInstallerUI } from "./install-ui.js";
import { strings } from "./install-i18n.js";

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

// Resolve the EXACT version behind DIST_TAG and install THAT — never the bare
// `@latest`/`@beta` dist-tag. OpenClaw persists a dist-tag install as a caret
// range (`"^1.0.5"`) in the managed project package.json, and OpenClaw's own
// plugin auto-update later rejects that range ("unsupported npm spec: use an
// exact version or dist-tag"), disabling the plugin. An exact version is stored
// as an exact spec, which auto-update accepts.
async function resolveTaggedVersion(distTag) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG}/${distTag}`, {
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
    const v = execSync(`npm view ${PKG}@${distTag} version`, {
      encoding: "utf8",
      timeout: 20000,
    }).trim();
    if (/^\d+\.\d+\.\d+/.test(v)) return v;
  } catch {
    /* fall through */
  }
  return null;
}

const installStep = ui.step(T.stepInstall);

const resolvedVersion = await resolveTaggedVersion(DIST_TAG);
// Registry lookup failed — fall back to the bare dist-tag so a transient network
// hiccup doesn't block the install. Re-running later pins an exact spec.
const installSpec = `${PKG}@${resolvedVersion ?? DIST_TAG}`;

try {
  execSync(`${openclawCmd} plugins install ${installSpec} --force`, {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 120000,
  });

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
  die(msg.trim().split("\n").pop() || T.failInstall, "npx -y @syengup/friday-channel-next");
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
try {
  // A full gateway restart commonly takes 20s+ on a fresh boot; give it plenty of room
  // so we don't kill it mid-restart and report a false failure.
  execSync(`${openclawCmd} gateway restart`, {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 90000,
  });
  restartStep.ok("");
} catch (e) {
  // ETIMEDOUT/SIGTERM here usually means the restart is simply slow, not broken —
  // the verify step below is the real gate either way, so never fail hard here.
  const slow = e.code === "ETIMEDOUT" || e.signal === "SIGTERM";
  restartStep.ok(slow ? T.detailRestartSlow : T.detailRestartUnconfirmed);
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

const verifyStep = ui.step(T.stepVerify);
const verified = await verifyGateway(verifyUrl, gatewayToken);

// Hard gate: if the gateway didn't verify, the install did NOT succeed — stop here
// with a non-zero exit and never print the QR block, so a failure can't look like
// a success.
if (!verified.ok) {
  verifyStep.fail(verified.reason);
  die(
    T.failGateway,
    "openclaw gateway status",
    "openclaw gateway restart",
    "npx -y @syengup/friday-channel-next",
  );
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

// Default QR: legacy `{url, token}` — what stable installs emit. The beta channel
// upgrades it to the public-access superset so a scan also arms remote access.
let qrFields = { url: gatewayUrl, token: gatewayToken };
if (DIST_TAG === "beta") {
  const pairing = await fetchPairingSuperset(verifyUrl, gatewayToken);
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
    ui.note(T.noteLanOnly);
  }
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
const QR_PUBLIC_SUFFIX = ".friday.syengup.host"; // must match PairingQRCrypto.swift
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
