#!/usr/bin/env node
/**
 * FridayNext relay service — subdomain allocation + ACME cert signing + tunnel gate
 *                            + control plane /v1 (Phase D1).
 *
 * /allocate  : the single authority that makes public subdomains collision-proof.
 *              key (sha256 of a gateway secret) → unique subdomain, idempotent.
 * /sign-cert : signs the gateway's CSR into a real Let's Encrypt cert via HTTP-01,
 *              WITHOUT ever seeing the private key (E2E preserved). A gateway can
 *              only get a cert for the subdomain its key was allocated (CN check),
 *              so it can't mint certs for other gateways' domains.
 *
 * frps NewProxy gate (port 7002, localhost-only, NOT nginx-exposed):
 *              frps calls this on EVERY tunnel registration. Only subdomains this
 *              allocator actually issued (present as a registry value) may open a
 *              tunnel; everything else is rejected AT THE RELAY. Because this runs
 *              on the server, a forked/modified open-source plugin — or a raw frpc
 *              carrying the leaked frps token — cannot bypass it: an unallocated
 *              subdomain is refused, and a server-enforced bandwidth cap bounds the
 *              damage of any allocated one. This is the un-bypassable half of the
 *              anti-abuse story; payment-gated allocation closes it fully later.
 *
 * Control plane /v1 (port 7003, localhost-only, nginx-exposed at
 * https://friday.syengup.host/v1/): the production upgrade of
 * scripts/testnet/mock-control-plane.mjs — same wire contract
 * (docs/public-access-contract.md §2), plus:
 *   • durable state (cp-state.json, atomic replace) + append-only audit.jsonl
 *   • REAL App Attest verification (node-app-attest, same lib as the gateway
 *     plugin). Invalid attestation → 403; absent/unverifiable → allowed but
 *     flagged while CP_ATTEST_REQUIRE=0 (free-test phase).
 *   • activate CLAIMS the gateway's already-allocated subdomain (registry check)
 *     instead of minting one — production tunnels are created by the plugin at
 *     install, the control plane only overlays entitlement/grants on them.
 *   • free-test entitlement (CP_FREE_TEST=1): first sight of an appAccountToken
 *     auto-seeds a 30-day trial and auto-extends it while free test lasts, so the
 *     subscription state machine runs for real and Phase F only flips the env.
 *   • ops: /v1/admin/* (bearer) — revoke / killswitch / state / backup; /v1/healthz.
 *     Revocations and the killswitch feed the frps NewProxy gate directly (same
 *     process, shared memory) and take effect at the next proxy (re)registration.
 *
 * Single Node process; all state written atomically under GW_ALLOC_DATA_DIR
 * (default /opt/gw-alloc). 7001/7002/7003 bind 127.0.0.1; nginx exposes 7001 at
 * /gw-alloc/ (prefix stripped) and 7003 at /v1/ (path passed through).
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileP = promisify(execFile);

const PORT = Number(process.env.GW_ALLOC_PORT || 7001);
const FRP_GATE_PORT = Number(process.env.FRP_GATE_PORT || 7002); // frps httpPlugin NewProxy callback; localhost-only
const CP_PORT = Number(process.env.CP_PORT || 7003); // control plane /v1; localhost-only, nginx-exposed
const HOST = "127.0.0.1";
const DATA_DIR = process.env.GW_ALLOC_DATA_DIR || "/opt/gw-alloc";
const DATA = path.join(DATA_DIR, "registry.json");
const CP_STATE = path.join(DATA_DIR, "cp-state.json");
const AUDIT = path.join(DATA_DIR, "audit.jsonl");
const TMP = path.join(DATA_DIR, "tmp");
const WEBROOT = "/var/www/acme";
const SUBDOMAIN_HOST = process.env.GW_SUBDOMAIN_HOST || "bj.gw.syengup.host";
const ACME_EMAIL = "admin@syengup.host";
// Bearer secret for /allocate + /sign-cert + /v1/admin. Sourced from the environment
// ONLY — never hardcoded, because this value is also the frps auth.token, which is
// shared with the operator's personal tunnels. Keeping it out of the (open-source)
// repo is what lets the relay be published without leaking the token. Set via
// systemd `Environment=GW_ALLOC_TOKEN=…`.
const TOKEN = process.env.GW_ALLOC_TOKEN;
if (!TOKEN) {
  console.error("FATAL: GW_ALLOC_TOKEN not set — refusing to start without a bearer secret");
  process.exit(1);
}
// Per-tunnel server-enforced bandwidth cap. Generous for a personal gateway
// (chat + attachments + canvas), but stops one tunnel saturating the relay.
const BW_LIMIT = process.env.GW_TUNNEL_BW || "4MB";

// ——— control-plane policy knobs (documented in docs/public-access-contract.md) ———
// Free-test phase: everyone is entitled (auto-trial); flip to 0 when Phase F (IAP) lands.
const FREE_TEST = process.env.CP_FREE_TEST !== "0";
// Require a VERIFIED App Attest on activate. 0 during free test (simulator/dev tolerated,
// invalid attestations are still rejected); flip to 1 with F.
const ATTEST_REQUIRE = process.env.CP_ATTEST_REQUIRE === "1";
// Enforce active grants at the frps gate (到期=中继停转发, D7). 0 until app-side
// activation is rolled out — otherwise never-activated but legitimately-paired
// gateways (pure QR flow) would be cut off. Flip with F.
const ENFORCE_GRANTS = process.env.CP_ENFORCE_GRANTS === "1";
const TUNNEL_CAP = Number(process.env.CP_TUNNEL_CAP || 3); // D31 per Apple ID
const NODES = (process.env.CP_NODES || "bj").split(",");
const APP_ATTEST_TEAM_ID = process.env.CP_ATTEST_TEAM_ID || "LQF97XWK5A";
const APP_ATTEST_BUNDLE_ID = process.env.CP_ATTEST_BUNDLE_ID || "SyengUp.FridayNext";
const DAY = 86_400_000;
const now = () => Date.now();
const rid = (n = 8) => crypto.randomBytes(n).toString("hex");

fs.mkdirSync(TMP, { recursive: true });

// ---------------------------------------------------------------------------
// Persistence — tiny data, single process: atomic-replace JSON + append audit.
// ---------------------------------------------------------------------------
function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function saveJson(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file); // atomic replace
}

const registry = loadJson(DATA, {}); // { keyHash: subdomain }
const used = new Set(Object.values(registry));

/** Control-plane durable state. Shapes mirror mock-control-plane.mjs Maps. */
const cp = Object.assign(
  {
    reservations: {}, // id → {qrTicket, expiresAt, gatewayId}
    tunnels: {}, // tunnelId → {appAccountToken, gatewayId, subdomain, node, createdAt}
    grants: {}, // grantId → {appAccountToken, tunnelId, deviceId, expiresAt, attested}
    subs: {}, // appAccountToken → {state, expiresAt, source}
    codes: {}, // CODE → {days, maxRedemptions, used, expiresAt, batch}
    attestKeys: {}, // keyId → {publicKey, signCount, environment, deviceId, createdAt}
    revoked: [], // [subdomain] — rejected at the frps gate on next registration
    killswitch: false, // emergency: reject ALL FridayNext-namespace registrations
  },
  loadJson(CP_STATE, {}),
);
function saveCp() {
  saveJson(CP_STATE, cp);
}

/** Append-only audit trail (D21). One JSON object per line; never rewritten. */
function audit(ev, fields = {}) {
  try {
    fs.appendFileSync(AUDIT, JSON.stringify({ ts: new Date().toISOString(), ev, ...fields }) + "\n");
  } catch {
    /* audit must never take the service down */
  }
}

function allocate(key) {
  if (registry[key]) return registry[key]; // idempotent
  let sub;
  do {
    sub = "fn" + crypto.randomBytes(5).toString("hex");
  } while (used.has(sub)); // registry-checked uniqueness = hard guarantee
  registry[key] = sub;
  used.add(sub);
  saveJson(DATA, registry);
  audit("allocate", { subdomain: sub });
  return sub;
}

// ---------------------------------------------------------------------------
// App Attest verification (real, same lib as the gateway plugin).
// node-app-attest is ESM → lazy dynamic import from this CJS file. If the module
// is missing (fresh box before `npm i`), verification degrades to "unavailable"
// (allowed-but-flagged while ATTEST_REQUIRE=0) instead of crashing the relay.
// ---------------------------------------------------------------------------
let appAttestMod = null;
let appAttestLoadTried = false;
async function loadAppAttest() {
  if (appAttestMod || appAttestLoadTried) return appAttestMod;
  appAttestLoadTried = true;
  try {
    appAttestMod = await import("node-app-attest");
  } catch (e) {
    console.error(`[cp] node-app-attest unavailable (${e.message}) — attest verify degraded`);
  }
  return appAttestMod;
}

/**
 * Verify the activation attestation. The client's clientDataHash is
 * SHA256(`${challenge}|${deviceId}`) with challenge = gatewayId (seamless, D33),
 * so the server reconstructs the exact payload from request fields.
 * Returns { verified, reason } and (on first attestation) stores the key.
 */
async function verifyActivationAttest(att, gatewayId, deviceId) {
  if (!att || typeof att !== "object" || !att.token) return { verified: false, reason: "absent" };
  if (att.kind === "mock") return { verified: false, reason: "mock" };
  const mod = await loadAppAttest();
  if (!mod) return { verified: false, reason: "verifier_unavailable" };
  const payload = `${gatewayId}|${deviceId}`;
  try {
    if (att.kind === "appattest-attest") {
      if (!att.keyId) return { verified: false, reason: "no_keyid" };
      const result = mod.verifyAttestation({
        attestation: Buffer.from(String(att.token), "base64"),
        challenge: payload,
        keyId: att.keyId,
        bundleIdentifier: APP_ATTEST_BUNDLE_ID,
        teamIdentifier: APP_ATTEST_TEAM_ID,
        allowDevelopmentEnvironment: true, // dev-signed installs keep working (see security todos)
      });
      cp.attestKeys[att.keyId] = {
        publicKey: result.publicKey,
        signCount: 0,
        environment: result.environment,
        deviceId,
        createdAt: now(),
      };
      saveCp();
      return { verified: true, reason: "attested" };
    }
    if (att.kind === "appattest-assert") {
      const stored = att.keyId ? cp.attestKeys[att.keyId] : null;
      // The app shares its App Attest keyId with the gateway-side attest session, so the
      // key may have been attested to the GATEWAY only — we have no public key to check
      // against. Not an attack signal; just unverifiable here. Allowed while
      // ATTEST_REQUIRE=0, and flagged in the grant + audit either way.
      if (!stored) return { verified: false, reason: "unknown_key" };
      const { signCount } = mod.verifyAssertion({
        assertion: Buffer.from(String(att.token), "base64"),
        payload,
        publicKey: stored.publicKey,
        bundleIdentifier: APP_ATTEST_BUNDLE_ID,
        teamIdentifier: APP_ATTEST_TEAM_ID,
        signCount: stored.signCount,
      });
      stored.signCount = signCount;
      saveCp();
      return { verified: true, reason: "asserted" };
    }
    return { verified: false, reason: `unknown_kind:${att.kind}` };
  } catch (e) {
    // A PRESENT-but-invalid attestation is an active bad signal → hard reject upstream.
    return { verified: false, reason: "invalid", invalid: true, detail: e.message || String(e) };
  }
}

// ---------------------------------------------------------------------------
// Entitlement (D8) + free-test auto-trial.
// ---------------------------------------------------------------------------
function entitled(appAccountToken) {
  const s = cp.subs[appAccountToken];
  if (s && ["trial", "active", "grace"].includes(s.state) && (!s.expiresAt || s.expiresAt > now()))
    return true;
  return false;
}

/** Free-test phase: seed/extend a trial so the state machine runs for real (D7/D14).
 * Flipping CP_FREE_TEST=0 simply stops the auto-extension — nothing else changes. */
function ensureFreeTestEntitlement(appAccountToken) {
  if (!FREE_TEST || !appAccountToken) return;
  const s = cp.subs[appAccountToken];
  if (!s) {
    cp.subs[appAccountToken] = { state: "trial", expiresAt: now() + 30 * DAY, source: "free-test" };
    saveCp();
    audit("trial.seed", { appAccountToken });
  } else if (s.source === "free-test" && s.state === "trial" && s.expiresAt <= now() + DAY) {
    s.expiresAt = now() + 30 * DAY;
    saveCp();
  }
}

function issueGrant(appAccountToken, tunnelId, deviceId, attested) {
  const grantId = rid();
  cp.grants[grantId] = { appAccountToken, tunnelId, deviceId, expiresAt: now() + 30 * DAY, attested };
  saveCp();
  return grantId;
}

/** Normalize an activate `subdomain` (bare "fnabc…" or full FQDN) to the bare label. */
function bareSubdomain(input) {
  const s = String(input || "").trim().toLowerCase();
  if (!s) return "";
  return s.endsWith("." + SUBDOMAIN_HOST) ? s.slice(0, -(SUBDOMAIN_HOST.length + 1)) : s;
}

function subdomainHasActiveGrant(sub) {
  for (const g of Object.values(cp.grants)) {
    const t = cp.tunnels[g.tunnelId];
    if (t && t.subdomain === sub && g.expiresAt > now()) return true;
  }
  return false;
}

// Serialize certbot runs — one ACME order at a time (shared account + webroot).
let certChain = Promise.resolve();
function withCertLock(fn) {
  const run = certChain.then(fn, fn);
  certChain = run.catch(() => {});
  return run;
}

/** Extract the CN from a PEM CSR. Returns "" if unreadable. */
async function csrCommonName(csrPath) {
  try {
    const { stdout } = await execFileP("openssl", ["req", "-in", csrPath, "-noout", "-subject"]);
    const m = stdout.match(/CN\s*=\s*([^,/\n]+)/);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

/** Sign a CSR into a real LE fullchain via HTTP-01. Throws on failure. */
async function signCert(subdomain, csrPem) {
  const fqdn = `${subdomain}.${SUBDOMAIN_HOST}`;
  const base = `${TMP}/${subdomain}-${crypto.randomBytes(4).toString("hex")}`;
  const csrPath = `${base}.csr`;
  const fullPath = `${base}.fullchain.pem`;
  const certPath = `${base}.cert.pem`;
  const chainPath = `${base}.chain.pem`;
  fs.writeFileSync(csrPath, csrPem);
  try {
    const cn = await csrCommonName(csrPath);
    if (cn !== fqdn) throw new Error(`CSR CN "${cn}" != allocated "${fqdn}"`);
    await execFileP(
      "certbot",
      [
        "certonly", "--non-interactive", "--agree-tos", "-m", ACME_EMAIL,
        "--webroot", "-w", WEBROOT,
        "--csr", csrPath,
        "--cert-path", certPath, "--fullchain-path", fullPath, "--chain-path", chainPath,
      ],
      { timeout: 120_000 },
    );
    return fs.readFileSync(fullPath, "utf8");
  } finally {
    for (const f of [csrPath, fullPath, certPath, chainPath]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Allocator + cert-signer (port 7001) — UNCHANGED wire behavior.
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const j = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const auth = req.headers.authorization || "";
  const tok = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (tok !== TOKEN) return j(401, { error: "unauthorized" });

  if (req.method !== "POST") return j(404, { error: "not found" });

  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 65_536) req.destroy();
  });
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return j(400, { error: "bad json" });
    }

    if (req.url === "/allocate") {
      const key = parsed.key;
      if (typeof key !== "string" || !/^[a-f0-9]{16,128}$/i.test(key)) {
        return j(400, { error: "bad key (expect hex hash 16-128 chars)" });
      }
      return j(200, { subdomain: allocate(key.toLowerCase()) });
    }

    if (req.url === "/sign-cert") {
      const key = parsed.key;
      const csr = parsed.csr;
      if (typeof key !== "string" || !/^[a-f0-9]{16,128}$/i.test(key)) {
        return j(400, { error: "bad key" });
      }
      if (typeof csr !== "string" || !csr.includes("BEGIN CERTIFICATE REQUEST")) {
        return j(400, { error: "bad csr" });
      }
      const subdomain = registry[key.toLowerCase()];
      if (!subdomain) return j(409, { error: "key has no allocated subdomain" });
      withCertLock(() => signCert(subdomain, csr))
        .then((fullchain) => {
          audit("sign-cert", { subdomain });
          j(200, { fullchain, fqdn: `${subdomain}.${SUBDOMAIN_HOST}` });
        })
        .catch((e) => j(502, { error: `cert signing failed: ${e.message || String(e)}` }));
      return;
    }

    return j(404, { error: "not found" });
  });
});
server.listen(PORT, HOST, () => console.log(`gw-alloc (alloc+cert) on ${HOST}:${PORT}`));

// ---------------------------------------------------------------------------
// frps NewProxy authorization gate (frp server httpPlugin protocol).
// frps POSTs {version, op, content} here for each proxy registration; we reply
// {reject, reject_reason, unchange, content}. Reachable only from localhost frps.
// ---------------------------------------------------------------------------
function allocatedSubdomain(name) {
  return typeof name === "string" && used.has(name.toLowerCase());
}

const frpGate = http.createServer((req, res) => {
  const reply = (obj) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ reject: true, reject_reason: "method not allowed" }));
    return;
  }
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 262_144) req.destroy();
  });
  req.on("end", () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      return reply({ reject: true, reject_reason: "bad json" });
    }
    const op = msg && msg.op;
    const content = (msg && msg.content) || {};
    // Only NewProxy is gated; anything else (Login/Ping/…) passes untouched.
    if (op !== "NewProxy") return reply({ reject: false, unchange: true });

    const sub = content.subdomain;
    const domains = Array.isArray(content.custom_domains) ? content.custom_domains : [];

    // SCOPE: this gate governs ONLY the FridayNext wildcard namespace —
    // `*.<SUBDOMAIN_HOST>`, which is claimed exclusively by https proxies that
    // set a `subdomain` (or a matching custom domain). Every other proxy on this
    // shared frps — the operator's own tcp/stcp/ssh tunnels (router_ssh, mac_ssh,
    // stcp_ha, …) — has no such subdomain and passes through UNTOUCHED. The gate
    // must never disturb the operator's pre-existing infrastructure.
    const host = SUBDOMAIN_HOST.toLowerCase();
    const claimsOurNamespace =
      (typeof sub === "string" && sub.trim() !== "") ||
      domains.some((d) => {
        const h = String(d).toLowerCase();
        return h === host || h.endsWith("." + host);
      });
    if (!claimsOurNamespace) return reply({ reject: false, unchange: true });

    // Emergency killswitch (D4/D21): reject every FridayNext-namespace registration.
    // Personal tunnels above are already through — they are never affected.
    if (cp.killswitch) {
      audit("gate.reject", { proxy: content.proxy_name, sub, reason: "killswitch" });
      return reply({ reject: true, reject_reason: "service suspended" });
    }

    // It claims our namespace → it MUST correspond to an allocated subdomain.
    const okSub = allocatedSubdomain(sub);
    const okDomain = domains.some((d) => allocatedSubdomain(String(d).split(".")[0]));

    if (!okSub && !okDomain) {
      const asked = sub || domains.join(",") || "(none)";
      console.log(`[frp-gate] REJECT proxy=${content.proxy_name} sub=${asked} — not allocated`);
      audit("gate.reject", { proxy: content.proxy_name, sub: asked, reason: "not_allocated" });
      return reply({ reject: true, reject_reason: "subdomain not allocated by relay" });
    }

    // Per-subdomain revocation (D4): allocated but administratively revoked → reject.
    const effectiveSub = okSub
      ? String(sub).toLowerCase()
      : String(domains.find((d) => allocatedSubdomain(String(d).split(".")[0])) || "")
          .split(".")[0]
          .toLowerCase();
    if (cp.revoked.includes(effectiveSub)) {
      audit("gate.reject", { proxy: content.proxy_name, sub: effectiveSub, reason: "revoked" });
      return reply({ reject: true, reject_reason: "subdomain revoked" });
    }

    // Grant enforcement (D7 到期=中继停转发). OFF until app-side activation is rolled
    // out (CP_ENFORCE_GRANTS=1) — see policy note at the top.
    if (ENFORCE_GRANTS && !subdomainHasActiveGrant(effectiveSub)) {
      audit("gate.reject", { proxy: content.proxy_name, sub: effectiveSub, reason: "no_active_grant" });
      return reply({ reject: true, reject_reason: "no active grant (subscription expired?)" });
    }

    // Accept + inject a server-enforced bandwidth cap. Echo the received content
    // verbatim so frp re-parses a well-formed config, overriding only the cap.
    content.bandwidth_limit = BW_LIMIT;
    content.bandwidth_limit_mode = "server";
    console.log(`[frp-gate] allow proxy=${content.proxy_name} sub=${sub || domains.join(",")} bw=${BW_LIMIT}`);
    return reply({ reject: false, unchange: false, content });
  });
});
frpGate.listen(FRP_GATE_PORT, HOST, () => console.log(`gw-alloc (frp-gate) on ${HOST}:${FRP_GATE_PORT}`));

// ---------------------------------------------------------------------------
// Control plane /v1 (port 7003) — the production mock-control-plane.mjs.
// Wire contract: docs/public-access-contract.md §2 (Swift DTOs decode these
// exact shapes). Public endpoints authenticate via appAccountToken + attest, not
// bearer; /v1/admin/*, /v1/codes/issue and /v1/apple/webhook require the operator
// bearer (the webhook switches to Apple JWS signature verification in Phase F).
// ---------------------------------------------------------------------------
function readBody(req, limit = 262_144) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > limit) req.destroy();
    });
    req.on("end", () => resolve(b));
    req.on("error", () => resolve(""));
  });
}

const cpServer = http.createServer(async (req, res) => {
  const j = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  // —— health (no auth; used by uptime monitoring + the off-site backup script) ——
  if (p === "/v1/healthz") {
    return j(200, { ok: true, uptimeSec: Math.floor(process.uptime()), killswitch: cp.killswitch });
  }

  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const isAdmin = bearer === TOKEN;

  // ————— admin/ops (bearer) —————
  if (p.startsWith("/v1/admin/") || p === "/v1/codes/issue" || p === "/v1/apple/webhook") {
    if (!isAdmin) return j(401, { error: "unauthorized" });
  }

  if (p === "/v1/admin/state" && req.method === "GET") {
    // Operational snapshot; attest public keys elided (bulky, not needed for ops).
    const { attestKeys, ...rest } = cp;
    return j(200, { ...rest, attestKeyCount: Object.keys(attestKeys).length, registry });
  }
  if (p === "/v1/admin/backup" && req.method === "GET") {
    // Full durable state for OFF-SITE pull (fetched nightly from the home Mac).
    return j(200, { ts: new Date().toISOString(), registry, cp });
  }

  if (req.method !== "POST") return j(404, { error: "not_found" });

  const raw = await readBody(req);
  let b = {};
  try {
    b = raw ? JSON.parse(raw) : {};
  } catch {
    return j(400, { error: "bad_json" });
  }

  if (p === "/v1/admin/revoke") {
    const sub = bareSubdomain(b.subdomain);
    if (!sub) return j(400, { error: "bad_subdomain" });
    if (!cp.revoked.includes(sub)) cp.revoked.push(sub);
    saveCp();
    audit("admin.revoke", { subdomain: sub });
    return j(200, { ok: true, revoked: cp.revoked });
  }
  if (p === "/v1/admin/unrevoke") {
    const sub = bareSubdomain(b.subdomain);
    cp.revoked = cp.revoked.filter((s) => s !== sub);
    saveCp();
    audit("admin.unrevoke", { subdomain: sub });
    return j(200, { ok: true, revoked: cp.revoked });
  }
  if (p === "/v1/admin/killswitch") {
    cp.killswitch = b.on === true;
    saveCp();
    audit("admin.killswitch", { on: cp.killswitch });
    return j(200, { ok: true, killswitch: cp.killswitch });
  }

  // ————— public /v1 (contract §2) —————

  // D12 one-time pairing ticket. (The plugin-side QR flow adopts this later; the
  // endpoint is live so the app-side reserve path can be built against production.)
  if (p === "/v1/tunnels/reserve") {
    const reservationId = rid();
    const qrTicket = rid(16);
    cp.reservations[reservationId] = {
      qrTicket,
      expiresAt: now() + 10 * 60_000,
      gatewayId: b.gatewayId || rid(6),
    };
    saveCp();
    audit("reserve", { reservationId });
    return j(200, { reservationId, qrTicket, ttlSec: 600, nodes: NODES });
  }

  // D3+D31+D33 activate: verify attest → check entitlement → CLAIM the gateway's
  // already-allocated subdomain → issue grant.
  if (p === "/v1/tunnels/activate") {
    const { reservationId, appAccountToken, deviceId, mode } = b;
    if (typeof appAccountToken !== "string" || !appAccountToken) {
      return j(400, { error: "bad_request", hint: "appAccountToken required" });
    }
    let gatewayId = b.gatewayId;
    if (mode !== "seamless") {
      const rsv = cp.reservations[reservationId];
      if (!rsv) return j(404, { error: "reservation_not_found" });
      if (rsv.expiresAt < now()) return j(410, { error: "ticket_expired" });
      gatewayId = rsv.gatewayId;
    }

    // Real App Attest (D3). Present-but-invalid → hard reject. Absent/unverifiable →
    // allowed while ATTEST_REQUIRE=0, but the grant is flagged unattested.
    const att = await verifyActivationAttest(b.attestation, gatewayId, deviceId);
    if (att.invalid) {
      audit("activate.attest_rejected", { appAccountToken, deviceId, detail: att.detail });
      return j(403, { error: "attest_rejected" });
    }
    if (ATTEST_REQUIRE && !att.verified) {
      audit("activate.attest_rejected", { appAccountToken, deviceId, reason: att.reason });
      return j(403, { error: "attest_rejected", hint: att.reason });
    }

    ensureFreeTestEntitlement(appAccountToken);
    if (!entitled(appAccountToken)) {
      return j(402, { error: "no_entitlement", hint: "需订阅/试用/兑换码" });
    }

    // Production semantics: the tunnel's subdomain was allocated by the gateway plugin
    // at install — activate CLAIMS it (must exist in the registry). The mock minted
    // one here; production never invents subdomains the gate would have to trust.
    const sub = bareSubdomain(b.subdomain);
    if (!sub) return j(400, { error: "subdomain_required", hint: "send the paired gateway's subdomain" });
    if (!used.has(sub)) return j(404, { error: "subdomain_not_allocated" });
    if (cp.revoked.includes(sub)) return j(403, { error: "subdomain_revoked" });

    const owned = Object.entries(cp.tunnels).filter(([, t]) => t.appAccountToken === appAccountToken);
    let tunnelId = (owned.find(([, t]) => t.subdomain === sub) || [])[0];
    if (!tunnelId) {
      if (owned.length >= TUNNEL_CAP) return j(409, { error: "tunnel_cap_reached", cap: TUNNEL_CAP });
      tunnelId = rid();
      cp.tunnels[tunnelId] = {
        appAccountToken,
        gatewayId: gatewayId || "",
        subdomain: sub,
        node: NODES[0],
        createdAt: now(),
      };
      saveCp();
    }
    const grantId = issueGrant(appAccountToken, tunnelId, deviceId || "", att.verified);
    audit("activate", { appAccountToken, subdomain: sub, grantId, attest: att.reason });
    return j(200, {
      tunnelId,
      subdomain: sub,
      node: cp.tunnels[tunnelId].node,
      publicUrl: `https://${sub}.${SUBDOMAIN_HOST}`,
      grantId,
      grantTtlSec: 30 * 86_400,
    });
  }

  // D16 grant sliding renewal
  if (p === "/v1/grants/renew") {
    const g = cp.grants[b.grantId];
    if (!g) return j(404, { error: "grant_not_found" });
    ensureFreeTestEntitlement(g.appAccountToken);
    if (!entitled(g.appAccountToken)) return j(402, { error: "no_entitlement" });
    g.expiresAt = now() + 30 * DAY;
    saveCp();
    audit("renew", { grantId: b.grantId });
    return j(200, { grantId: b.grantId, expiresAt: g.expiresAt });
  }

  // D8 subscription state (anonymous — appAccountToken only)
  if (p === "/v1/subscriptions/verify") {
    const s = cp.subs[b.appAccountToken];
    if (!s) return j(200, { state: "none", entitled: false });
    return j(200, { state: s.state, entitled: entitled(b.appAccountToken), expiresAt: s.expiresAt });
  }

  // D32 issue (admin — gated above)
  if (p === "/v1/codes/issue") {
    const code = String(b.code || rid(5)).toUpperCase();
    cp.codes[code] = {
      days: b.days || 365,
      maxRedemptions: b.maxRedemptions || 1,
      used: 0,
      expiresAt: now() + (b.validDays || 30) * DAY,
      batch: b.batch || "default",
    };
    saveCp();
    audit("code.issue", { code, days: cp.codes[code].days, batch: cp.codes[code].batch });
    return j(200, { code, ...cp.codes[code] });
  }

  // D32 redeem
  if (p === "/v1/codes/redeem") {
    const c = cp.codes[String(b.code || "").toUpperCase()];
    if (!c) return j(404, { error: "code_invalid" });
    if (c.expiresAt < now()) return j(410, { error: "code_expired" });
    if (c.used >= c.maxRedemptions) return j(409, { error: "code_exhausted" });
    c.used++;
    const prev = cp.subs[b.appAccountToken];
    const base = prev && prev.expiresAt > now() ? prev.expiresAt : now();
    cp.subs[b.appAccountToken] = { state: "active", expiresAt: base + c.days * DAY, source: "code" };
    saveCp();
    audit("code.redeem", { code: String(b.code).toUpperCase(), appAccountToken: b.appAccountToken });
    return j(200, { ok: true, grantedDays: c.days, expiresAt: cp.subs[b.appAccountToken].expiresAt });
  }

  // Refund reclaim (App Store Server Notifications v2). Admin-bearer for now — real
  // Apple JWS signature verification replaces this auth in Phase F; until the IAP
  // product exists Apple sends nothing, and an OPEN revocation endpoint would let
  // anyone strip users' grants.
  if (p === "/v1/apple/webhook") {
    const { notificationType, appAccountToken } = b;
    if (["REFUND", "REVOKE", "EXPIRED"].includes(notificationType)) {
      cp.subs[appAccountToken] = {
        state: notificationType === "EXPIRED" ? "expired" : "refunded",
        expiresAt: now(),
      };
      for (const [gid, g] of Object.entries(cp.grants)) {
        if (g.appAccountToken === appAccountToken) delete cp.grants[gid];
      }
      saveCp();
      audit("webhook", { notificationType, appAccountToken });
    }
    return j(200, { ok: true });
  }

  return j(404, { error: "not_found" });
});
cpServer.listen(CP_PORT, HOST, () =>
  console.log(
    `gw-alloc (control-plane) on ${HOST}:${CP_PORT} freeTest=${FREE_TEST} attestRequire=${ATTEST_REQUIRE} enforceGrants=${ENFORCE_GRANTS}`,
  ),
);
