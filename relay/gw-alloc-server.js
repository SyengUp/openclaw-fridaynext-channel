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
const TMP = path.join(DATA_DIR, "tmp");
const WEBROOT = "/var/www/acme";
const SUBDOMAIN_HOST = process.env.GW_SUBDOMAIN_HOST || "bj.gw.syengup.host";
const ACME_EMAIL = "admin@syengup.host";
// Bearer secret for /allocate + /sign-cert. Sourced from the environment ONLY — never
// hardcoded, because this value is also the frps auth.token, which is shared with the
// operator's personal tunnels AND distributed to every user gateway (the plugin needs it
// to allocate and to run frpc). It is therefore treated as SEMI-PUBLIC — which is exactly
// why it must NOT guard admin surfaces. Set via systemd `Environment=GW_ALLOC_TOKEN=…`.
const TOKEN = process.env.GW_ALLOC_TOKEN;
if (!TOKEN) {
  console.error("FATAL: GW_ALLOC_TOKEN not set — refusing to start without a bearer secret");
  process.exit(1);
}
// SEPARATE operator-only bearer for /v1/admin/*, /v1/codes/issue and /v1/apple/webhook.
// The NewProxy gate's whole threat model treats GW_ALLOC_TOKEN as leaked; the same value
// must never also be the key to backup exfiltration / global killswitch / issuing
// ourselves 365-day codes. Held only by the operator (systemd env + the off-site backup
// puller); never shipped to user gateways.
const ADMIN_TOKEN = process.env.GW_ALLOC_ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  console.error("FATAL: GW_ALLOC_ADMIN_TOKEN not set — refusing to start without an admin bearer");
  process.exit(1);
}
if (ADMIN_TOKEN === TOKEN) {
  console.error("FATAL: GW_ALLOC_ADMIN_TOKEN must differ from GW_ALLOC_TOKEN (the split is the point)");
  process.exit(1);
}

/** Constant-time bearer comparison (=== leaks length/prefix timing; one-liner to not). */
function tokenEqual(presented, expected) {
  if (typeof presented !== "string" || !presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

// ——— OSS attachment side-channel (Phase E) ———
// Presigned-URL model: the control plane holds the long-term OSS key and signs
// short-lived scoped PUT/GET URLs; clients do plain HTTP (progress/Range resume
// for free, no OSS SDK anywhere). Absent config → 503 oss_not_configured and the
// app falls back to the tunnel path — the side-channel is an optimization, never
// a dependency. Bucket lifecycle (1–7d auto-delete) is provisioned bucket-side (E6).
const OSS_BUCKET = process.env.OSS_BUCKET || ""; // e.g. "fridaynext-attach"
const OSS_ENDPOINT = process.env.OSS_ENDPOINT || ""; // e.g. "oss-cn-beijing.aliyuncs.com"
const OSS_ACCESS_KEY_ID = process.env.OSS_ACCESS_KEY_ID || "";
const OSS_ACCESS_KEY_SECRET = process.env.OSS_ACCESS_KEY_SECRET || "";
// Testnet/mock override: when set, signed URLs point at the mock OSS instead of Aliyun.
const OSS_MOCK_BASE = process.env.OSS_MOCK_BASE || "";
const OSS_URL_TTL_SEC = Number(process.env.OSS_URL_TTL_SEC || 900); // 15 min
const OSS_MAX_OBJECT_BYTES = Number(process.env.OSS_MAX_OBJECT_BYTES || 100 * 1024 * 1024);
// Monthly per-tunnel traffic caps (PRD §10: trial well below paid; paid 3GB).
const OSS_CAP_TRIAL = Number(process.env.OSS_CAP_TRIAL || 300 * 1024 * 1024);
const OSS_CAP_PAID = Number(process.env.OSS_CAP_PAID || 3 * 1024 * 1024 * 1024);

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

/** Load a REQUIRED state file. A missing/empty file is a legitimate fresh start; a file
 * that EXISTS but can't be parsed is corruption — refuse to boot rather than silently
 * starting empty, because the next saveCp()/saveJson() would overwrite the only copy of
 * production state (grants, subscriptions, allocations) with defaults and destroy the
 * evidence. Restore from the off-site backup or fix the file, then restart. */
function loadJsonStrict(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return fallback; // ENOENT etc — fresh start
  }
  if (!raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(
      `FATAL: ${file} exists but is unparseable (${e.message}) — refusing to start. ` +
        `Continuing would clobber production state with empty defaults on the next save. ` +
        `Restore it from the off-site backup (latest.json) before restarting.`,
    );
    process.exit(1);
  }
}
function saveJson(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file); // atomic replace
}

const registry = loadJsonStrict(DATA, {}); // { keyHash: subdomain }
const used = new Set(Object.values(registry));
// Per-Apple-ID subdomains (cp.appleSubs) must ALSO count as allocated at the frps gate —
// they live in cp-state, not the registry, so fold them into `used` after cp loads below.

/** Control-plane durable state. Shapes mirror mock-control-plane.mjs Maps. */
const cp = Object.assign(
  {
    reservations: {}, // id → {qrTicket, expiresAt, gatewayId}
    tunnels: {}, // tunnelId → {appAccountToken, gatewayId, subdomain, node, createdAt}
    grants: {}, // grantId → {appAccountToken, tunnelId, deviceId, expiresAt, attested}
    subs: {}, // appAccountToken → {state, expiresAt, source}
    codes: {}, // CODE → {days, maxRedemptions, used, expiresAt, batch}
    // D31 per-Apple-ID subdomains: `${gatewayKey}:${appAccountToken}` → subdomain. The FIRST
    // Apple ID on a gateway reuses the gateway's base subdomain (registry[gatewayKey]); each
    // ADDITIONAL Apple ID gets its own. The gateway polls /v1/gateway/subdomains to learn which
    // to run an frpc proxy for, so an un-granted Apple ID simply has no reachable subdomain.
    appleSubs: {},
    attestKeys: {}, // keyId → {publicKey, signCount, environment, deviceId, createdAt}
    revoked: [], // [subdomain] — rejected at the frps gate on next registration
    killswitch: false, // emergency: reject ALL FridayNext-namespace registrations
    ossUsage: {}, // subdomain → { month: "2026-07", bytes } — sign-time traffic accounting
  },
  loadJsonStrict(CP_STATE, {}),
);
function saveCp() {
  saveJson(CP_STATE, cp);
}

// Fold persisted per-Apple-ID subdomains into the gate's allocated set (see note by `used`).
for (const sub of Object.values(cp.appleSubs || {})) used.add(sub);

// One-time attest nonces (P2-19) — in-memory is fine: 5-min TTL, and a relay restart
// invalidating outstanding nonces just means one extra round-trip for the client.
const attestNonces = new Map(); // nonce → expiresAt(ms)

/** Append-only audit trail (D21), rotated monthly (`audit-YYYY-MM.jsonl`) so it can't
 * grow without bound under sign/gate spam. One JSON object per line; never rewritten. */
function audit(ev, fields = {}) {
  try {
    const file = path.join(DATA_DIR, `audit-${new Date().toISOString().slice(0, 7)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ev, ...fields }) + "\n");
  } catch {
    /* audit must never take the service down */
  }
}

function mintSubdomain() {
  let sub;
  do {
    sub = "fn" + crypto.randomBytes(5).toString("hex");
  } while (used.has(sub)); // registry-checked uniqueness = hard guarantee
  return sub;
}

function allocate(key) {
  if (registry[key]) return registry[key]; // idempotent
  const sub = mintSubdomain();
  registry[key] = sub;
  used.add(sub);
  saveJson(DATA, registry);
  audit("allocate", { subdomain: sub });
  return sub;
}

/**
 * D31: resolve the per-Apple-ID subdomain for (gatewayKey, appAccountToken). The FIRST Apple
 * ID to activate on a gateway reuses the gateway's base subdomain (so single-user installs are
 * byte-identical to the pre-D31 world); each ADDITIONAL Apple ID gets a freshly-minted one.
 * All per-Apple-ID subs join `used`, so the frps gate authorizes them like any allocation.
 */
function resolveAppleSubdomain(gatewayKey, appAccountToken, baseSub) {
  const mapKey = `${gatewayKey}:${appAccountToken}`;
  if (cp.appleSubs[mapKey]) return cp.appleSubs[mapKey];
  // Reuse the base subdomain for the first owner; mint a distinct one for everyone after.
  const baseTaken = Object.values(cp.appleSubs).includes(baseSub);
  const sub = baseTaken ? mintSubdomain() : baseSub;
  cp.appleSubs[mapKey] = sub;
  used.add(sub);
  saveCp();
  audit("apple-sub.assign", { gatewayKey: gatewayKey.slice(0, 12), subdomain: sub, reused: sub === baseSub });
  return sub;
}

/** Whether a subdomain currently belongs to an entitled Apple ID with a live-or-recent grant —
 * the truth the gateway poll and the expiry sweep both consult. */
function appleSubActive(sub) {
  return subdomainHasActiveGrant(sub) || subdomainHasEntitledOwner(sub);
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

/** Whether any tunnel on `sub` is owned by a still-ENTITLED account, even if its grant
 * lapsed. Grants slide on app activity (D16); a paying user who doesn't open the app for
 * 30 days would otherwise be cut at the next frpc reconnect despite a valid subscription
 * — the gate treats "entitled owner, stale grant" as pass. */
function subdomainHasEntitledOwner(sub) {
  for (const t of Object.values(cp.tunnels)) {
    if (t.subdomain === sub && entitled(t.appAccountToken)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Immediate enforcement (P1-5). frps has no per-proxy close API, so the ONLY way to cut
// an ALREADY-ESTABLISHED tunnel is to restart frps: every frpc reconnects within seconds
// and re-registers through the NewProxy gate, where revocation/killswitch/grant checks
// now apply. Personal (non-FridayNext) tunnels re-register untouched — they just blip
// for a couple of seconds, which is why this fires only on explicit admin actions and
// the (ENFORCE_GRANTS-gated) expiry sweep, never routinely.
// ---------------------------------------------------------------------------
const FRPS_RESTART_ENABLED = process.env.GW_FRPS_RESTART !== "0";
let lastFrpsRestartAt = 0;
function forceProxyReregistration(reason) {
  if (!FRPS_RESTART_ENABLED) {
    audit("frps.restart.skipped", { reason, why: "GW_FRPS_RESTART=0" });
    return;
  }
  lastFrpsRestartAt = now();
  execFile("systemctl", ["restart", "frps"], (err) => {
    audit("frps.restart", { reason, ok: !err, err: err ? String(err.message || err) : undefined });
    if (err) console.error(`[enforce] frps restart failed: ${err.message}`);
    else console.log(`[enforce] frps restarted (${reason}) — all proxies re-register through the gate`);
  });
}

// Live registrations the gate has allowed since boot (sub → last NewProxy ts). Feeds the
// expiry sweep: a sub that registered while granted but whose grant/entitlement has since
// lapsed keeps serving until frpc reconnects — the sweep forces that re-registration.
const gateAllowedSubs = new Map();
const EXPIRY_SWEEP_INTERVAL_MS = 10 * 60_000;
const EXPIRY_SWEEP_RESTART_COOLDOWN_MS = 60 * 60_000; // at most one sweep restart per hour
if (ENFORCE_GRANTS) {
  const sweep = setInterval(() => {
    const stale = [...gateAllowedSubs.keys()].filter(
      (sub) =>
        !subdomainHasActiveGrant(sub) && !subdomainHasEntitledOwner(sub),
    );
    if (!stale.length) return;
    if (now() - lastFrpsRestartAt < EXPIRY_SWEEP_RESTART_COOLDOWN_MS) return;
    audit("enforce.sweep", { stale });
    forceProxyReregistration(`expiry-sweep:${stale.join(",")}`);
  }, EXPIRY_SWEEP_INTERVAL_MS);
  sweep.unref?.();
}

// ---------------------------------------------------------------------------
// State GC — cp-state only ever grew (expired reservations/grants/codes, past-month OSS
// usage), inflating every full-state save and every O(n) scan. Sweep at boot + daily.
// Expired grants get a 90-day retention (post-mortem/debugging value) before deletion.
// ---------------------------------------------------------------------------
function gcState() {
  const t = now();
  let dropped = 0;
  for (const [id, r] of Object.entries(cp.reservations)) {
    if (r.expiresAt < t) {
      delete cp.reservations[id];
      dropped++;
    }
  }
  for (const [id, g] of Object.entries(cp.grants)) {
    if (g.expiresAt < t - 90 * DAY) {
      delete cp.grants[id];
      dropped++;
    }
  }
  for (const [code, c] of Object.entries(cp.codes)) {
    if (c.expiresAt < t - 90 * DAY) {
      delete cp.codes[code];
      dropped++;
    }
  }
  const month = new Date().toISOString().slice(0, 7);
  for (const [sub, u] of Object.entries(cp.ossUsage)) {
    if (u.month !== month) {
      delete cp.ossUsage[sub];
      dropped++;
    }
  }
  if (dropped) {
    saveCp();
    audit("gc", { dropped });
  }
}
gcState();
const gcTimer = setInterval(gcState, DAY);
gcTimer.unref?.();

// ---------------------------------------------------------------------------
// OSS side-channel signing (Phase E).
// ---------------------------------------------------------------------------
function ossConfigured() {
  return Boolean(OSS_MOCK_BASE || (OSS_BUCKET && OSS_ENDPOINT && OSS_ACCESS_KEY_ID && OSS_ACCESS_KEY_SECRET));
}

/** Monthly cap for a tunnel: paid tier if ANY entitled non-trial sub owns a grant on it. */
function ossCapFor(sub) {
  for (const g of Object.values(cp.grants)) {
    const t = cp.tunnels[g.tunnelId];
    if (!t || t.subdomain !== sub || g.expiresAt <= now()) continue;
    const s = cp.subs[g.appAccountToken];
    if (s && s.state === "active" && (!s.expiresAt || s.expiresAt > now())) return OSS_CAP_PAID;
  }
  return OSS_CAP_TRIAL;
}

/** Sign-time traffic accounting (both directions count against the tunnel's month). */
function ossCharge(sub, bytes) {
  const month = new Date().toISOString().slice(0, 7);
  const u = cp.ossUsage[sub];
  if (!u || u.month !== month) cp.ossUsage[sub] = { month, bytes: 0 };
  cp.ossUsage[sub].bytes += bytes;
  saveCp();
  return cp.ossUsage[sub].bytes;
}

function ossUsedBytes(sub) {
  const month = new Date().toISOString().slice(0, 7);
  const u = cp.ossUsage[sub];
  return u && u.month === month ? u.bytes : 0;
}

/**
 * Presign an Aliyun OSS V1 URL (HMAC-SHA1 query auth) — hand-rolled, zero deps.
 * StringToSign = VERB\nContent-MD5\nContent-Type\nExpires\nCanonicalizedResource.
 * In mock mode the URL targets the testnet mock OSS with the same query shape
 * (the mock does not verify signatures — contract-shape parity only).
 */
function ossPresign(method, objectKey, contentType) {
  const expires = Math.floor(now() / 1000) + OSS_URL_TTL_SEC;
  if (OSS_MOCK_BASE) {
    return {
      url: `${OSS_MOCK_BASE.replace(/\/$/, "")}/${objectKey}?Expires=${expires}&Signature=mock`,
      headers: contentType ? { "content-type": contentType } : {},
      expiresAt: expires * 1000,
    };
  }
  const resource = `/${OSS_BUCKET}/${objectKey}`;
  const stringToSign = `${method}\n\n${contentType || ""}\n${expires}\n${resource}`;
  const signature = crypto.createHmac("sha1", OSS_ACCESS_KEY_SECRET).update(stringToSign).digest("base64");
  const q = new URLSearchParams({
    OSSAccessKeyId: OSS_ACCESS_KEY_ID,
    Expires: String(expires),
    Signature: signature,
  });
  return {
    url: `https://${OSS_BUCKET}.${OSS_ENDPOINT}/${encodeURI(objectKey)}?${q}`,
    headers: contentType ? { "content-type": contentType } : {},
    expiresAt: expires * 1000,
  };
}

/** Resolve + authorize the tunnel a /v1/oss/sign request acts on. Two caller legs:
 *  app: { appAccountToken, grantId } — grant must be live and owned by the token;
 *  gateway plugin: { gatewayKey } — sha256 hex present in the allocation registry.
 *  Returns { sub } or { error: [status, code] }. */
function ossResolveTunnel(b) {
  if (typeof b.gatewayKey === "string" && /^[a-f0-9]{16,128}$/i.test(b.gatewayKey)) {
    const sub = registry[b.gatewayKey.toLowerCase()];
    return sub ? { sub } : { error: [404, "gateway_not_allocated"] };
  }
  const g = cp.grants[b.grantId];
  if (!g || g.appAccountToken !== b.appAccountToken) return { error: [404, "grant_not_found"] };
  if (g.expiresAt <= now()) return { error: [403, "grant_expired"] };
  ensureFreeTestEntitlement(b.appAccountToken);
  if (!entitled(b.appAccountToken)) return { error: [402, "no_entitlement"] };
  const t = cp.tunnels[g.tunnelId];
  return t ? { sub: t.subdomain } : { error: [404, "grant_not_found"] };
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
  if (!tokenEqual(tok, TOKEN)) return j(401, { error: "unauthorized" });

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
        .catch((e) => {
          // Detail (certbot stderr, paths) goes to the audit log only — the response
          // audience is every token holder, and stderr can leak internals.
          audit("sign-cert.error", { subdomain, detail: String(e.message || e).slice(0, 500) });
          j(502, { error: "cert_signing_failed" });
        });
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

    // It claims our namespace → it MUST correspond to an allocated subdomain. One pass:
    // resolve the effective bare label ("" = nothing allocated matches).
    const effectiveSub = allocatedSubdomain(sub)
      ? String(sub).toLowerCase()
      : String(domains.find((d) => allocatedSubdomain(String(d).split(".")[0])) || "")
          .split(".")[0]
          .toLowerCase();
    if (!effectiveSub) {
      const asked = sub || domains.join(",") || "(none)";
      console.log(`[frp-gate] REJECT proxy=${content.proxy_name} sub=${asked} — not allocated`);
      audit("gate.reject", { proxy: content.proxy_name, sub: asked, reason: "not_allocated" });
      gateAllowedSubs.delete(String(sub || "").toLowerCase());
      return reply({ reject: true, reject_reason: "subdomain not allocated by relay" });
    }

    // Per-subdomain revocation (D4): allocated but administratively revoked → reject.
    if (cp.revoked.includes(effectiveSub)) {
      audit("gate.reject", { proxy: content.proxy_name, sub: effectiveSub, reason: "revoked" });
      gateAllowedSubs.delete(effectiveSub);
      return reply({ reject: true, reject_reason: "subdomain revoked" });
    }

    // Grant enforcement (D7 到期=中继停转发). OFF until app-side activation is rolled
    // out (CP_ENFORCE_GRANTS=1) — see policy note at the top. "Entitled owner with a
    // stale grant" passes (silent-but-paying users must not be cut on reconnect).
    if (
      ENFORCE_GRANTS &&
      !subdomainHasActiveGrant(effectiveSub) &&
      !subdomainHasEntitledOwner(effectiveSub)
    ) {
      audit("gate.reject", { proxy: content.proxy_name, sub: effectiveSub, reason: "no_active_grant" });
      gateAllowedSubs.delete(effectiveSub);
      return reply({ reject: true, reject_reason: "no active grant (subscription expired?)" });
    }

    gateAllowedSubs.set(effectiveSub, now()); // feeds the ENFORCE_GRANTS expiry sweep

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
  // Admin surfaces take ONLY the operator token — never GW_ALLOC_TOKEN, which every user
  // gateway holds (see the token-split note at the top).
  const isAdmin = tokenEqual(bearer, ADMIN_TOKEN);

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
    // Cut the LIVE tunnel too — without this, revocation only bites at the proxy's next
    // natural reconnect, which can be days away.
    forceProxyReregistration(`revoke:${sub}`);
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
    // Engaging the killswitch must stop abuse NOW, not at the abuser's next reconnect.
    if (cp.killswitch) forceProxyReregistration("killswitch");
    return j(200, { ok: true, killswitch: cp.killswitch });
  }
  // Batch-clamp free-test trials to a cutoff (Phase F day-one tool: "即日起未付费即停"
  // without hand-revoking every subdomain). Body: { expiresAt: ms | ISO string }.
  if (p === "/v1/admin/free-test-clamp") {
    const cutoff = typeof b.expiresAt === "string" ? Date.parse(b.expiresAt) : Number(b.expiresAt);
    if (!Number.isFinite(cutoff) || cutoff <= 0) return j(400, { error: "bad_expires_at" });
    let clamped = 0;
    for (const s of Object.values(cp.subs)) {
      if (s.source === "free-test" && (!s.expiresAt || s.expiresAt > cutoff)) {
        s.expiresAt = cutoff;
        clamped++;
      }
    }
    saveCp();
    audit("admin.free-test-clamp", { cutoff, clamped });
    return j(200, { ok: true, clamped, cutoff });
  }

  // ————— public /v1 (contract §2) —————

  // D31 gateway reconcile poll. The gateway proves identity by knowing gatewayKey =
  // sha256(its own bearer) — present in the allocation registry, and never derivable by a
  // third party who only saw a public URL. Returns the per-Apple-ID subdomains it should be
  // running an frpc proxy for RIGHT NOW (active grant or still-entitled owner); the plugin
  // reconciles its proxy set against this. Un-granted Apple IDs are simply absent → no proxy
  // → no reachable subdomain, which is how family-freeloading is closed under ENFORCE_GRANTS.
  if (p === "/v1/gateway/subdomains") {
    const gk = typeof b.gatewayKey === "string" ? b.gatewayKey.trim().toLowerCase() : "";
    if (!gk || !registry[gk]) return j(403, { error: "gateway_not_allocated" });
    const prefix = `${gk}:`;
    const active = [];
    for (const [mk, sub] of Object.entries(cp.appleSubs)) {
      if (!mk.startsWith(prefix)) continue;
      if (cp.revoked.includes(sub)) continue;
      // When enforcement is off, every assigned sub is served (matches today's behavior);
      // when on, only entitled/granted ones — the freeloading close.
      if (!ENFORCE_GRANTS || appleSubActive(sub)) active.push(sub);
    }
    // Always include the base subdomain itself so the owner's existing tunnel keeps running
    // even before their first activate (backward-compat with pre-D31 installs).
    const baseSub = registry[gk];
    if (!cp.revoked.includes(baseSub) && !active.includes(baseSub)) {
      if (!ENFORCE_GRANTS || appleSubActive(baseSub)) active.push(baseSub);
    }
    return j(200, { subdomains: active, subDomainHost: SUBDOMAIN_HOST });
  }

  // One-time attest nonce (P2-19). The static `gatewayId|deviceId` challenge made every
  // attestation/assertion replayable forever; a consumed server nonce restores freshness.
  // Optional while ATTEST_REQUIRE=0 (legacy static challenge still accepted); REQUIRED
  // alongside the attestation once ATTEST_REQUIRE=1.
  if (p === "/v1/attest/nonce") {
    for (const [n, exp] of attestNonces) if (exp < now()) attestNonces.delete(n);
    if (attestNonces.size > 10_000) return j(429, { error: "too_many_nonces" });
    const nonce = rid(16);
    attestNonces.set(nonce, now() + 5 * 60_000);
    return j(200, { nonce, ttlSec: 300 });
  }

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

    // Challenge freshness (P2-19): a server-issued one-time nonce when provided (consumed
    // here — replay of the same attestation blob then fails the challenge check). The
    // legacy static gatewayId challenge is tolerated only while ATTEST_REQUIRE=0.
    let challenge = gatewayId;
    if (typeof b.attestNonce === "string" && b.attestNonce) {
      const exp = attestNonces.get(b.attestNonce);
      attestNonces.delete(b.attestNonce);
      if (!exp || exp < now()) return j(403, { error: "attest_rejected", hint: "stale_nonce" });
      challenge = b.attestNonce;
    } else if (ATTEST_REQUIRE && b.attestation) {
      return j(403, { error: "attest_rejected", hint: "nonce_required" });
    }

    // Real App Attest (D3). Present-but-invalid → hard reject. Absent/unverifiable →
    // allowed while ATTEST_REQUIRE=0, but the grant is flagged unattested.
    const att = await verifyActivationAttest(b.attestation, challenge, deviceId);
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

    // The `subdomain` the app sends is the gateway's BASE subdomain (from the QR / durable
    // pairing) — the ownership TARGET. Under D31 the tunnel it actually activates is the
    // caller's PER-APPLE-ID subdomain (the base for the first owner, a distinct one after),
    // resolved below. Production never invents base subdomains the gate wouldn't trust.
    const baseSub = bareSubdomain(b.subdomain);
    if (!baseSub) return j(400, { error: "subdomain_required", hint: "send the paired gateway's subdomain" });
    if (!used.has(baseSub)) return j(404, { error: "subdomain_not_allocated" });

    const owned = Object.entries(cp.tunnels).filter(([, t]) => t.appAccountToken === appAccountToken);
    const gk = typeof b.gatewayKey === "string" ? b.gatewayKey.trim().toLowerCase() : "";
    // Ownership proof (P0-4): gatewayKey = sha256(the gateway's bearer token) — the same key
    // the plugin allocated the base subdomain under, which only a genuinely-paired app can
    // derive from the bearer it holds. The subdomain is public (it's in every URL); knowing
    // the bearer is what proves pairing. Required unless this Apple ID already owns a tunnel
    // here (ownership was proven at first claim). Also the key under which the per-Apple-ID
    // subdomain is filed, so it must be present+correct on the first activate.
    const mapKey = `${gk}:${appAccountToken}`;
    const alreadyMine = Boolean(cp.appleSubs[mapKey]) || owned.length > 0;
    if (!alreadyMine) {
      if (!gk || registry[gk] !== baseSub) {
        audit("activate.ownership_rejected", { appAccountToken, subdomain: baseSub });
        return j(403, { error: "subdomain_ownership_required", hint: "send gatewayKey" });
      }
    }

    // Resolve the per-Apple-ID subdomain (D31). Needs the verified gatewayKey; re-activations
    // recover it from the stored gatewayId→key isn't available, so require gk here too when a
    // fresh assignment would be minted.
    const resolveKey = gk || Object.keys(cp.appleSubs).find((k) => k.endsWith(`:${appAccountToken}`))?.split(":")[0];
    if (!resolveKey) {
      return j(403, { error: "subdomain_ownership_required", hint: "send gatewayKey" });
    }
    const sub = resolveAppleSubdomain(resolveKey, appAccountToken, baseSub);
    if (cp.revoked.includes(sub)) return j(403, { error: "subdomain_revoked" });

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

  // D16 grant sliding renewal. The grant may not outlive the subscription it rides on
  // (+72h grace, D-series 宽限) — an unconditional now+30d let a user renew on the eve
  // of expiry and keep the tunnel a whole month past their subscription.
  if (p === "/v1/grants/renew") {
    const g = cp.grants[b.grantId];
    if (!g) return j(404, { error: "grant_not_found" });
    ensureFreeTestEntitlement(g.appAccountToken);
    if (!entitled(g.appAccountToken)) return j(402, { error: "no_entitlement" });
    if (ATTEST_REQUIRE && !g.attested) {
      // Grants issued before the attest wall went up don't get to slide past it.
      audit("renew.attest_rejected", { grantId: b.grantId });
      return j(403, { error: "attest_rejected", hint: "re-activate with attestation" });
    }
    const s = cp.subs[g.appAccountToken];
    const subCeiling = s && s.expiresAt ? s.expiresAt + 72 * 3600_000 : Infinity;
    g.expiresAt = Math.min(now() + 30 * DAY, subCeiling);
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

  // Phase E — OSS attachment side-channel: presign a scoped PUT/GET URL.
  // Two caller legs (see ossResolveTunnel): the app (grant) and the gateway plugin
  // (gatewayKey). The blob is client-encrypted before upload — the control plane only
  // signs a storage URL and meters bytes; it never sees a content key or plaintext.
  // 503 when OSS isn't provisioned → the app falls back to the tunnel path.
  if (p === "/v1/oss/sign") {
    if (!ossConfigured()) return j(503, { error: "oss_not_configured" });
    const op = b.op === "get" ? "get" : b.op === "put" ? "put" : null;
    if (!op) return j(400, { error: "bad_op", hint: 'op must be "put" or "get"' });
    const resolved = ossResolveTunnel(b);
    if (resolved.error) return j(resolved.error[0], { error: resolved.error[1] });
    const sub = resolved.sub;

    // objectKey is always scoped under the tunnel's subdomain prefix so one tunnel can
    // never read/overwrite another's blobs (enforced again by the RAM policy in prod).
    const objId = String(b.objectId || "").replace(/[^a-zA-Z0-9._-]/g, "");
    if (!objId) return j(400, { error: "bad_object_id" });
    const objectKey = `att/${sub}/${objId}`;

    if (op === "put") {
      const size = Number(b.size || 0);
      if (!Number.isFinite(size) || size <= 0) return j(400, { error: "bad_size" });
      if (size > OSS_MAX_OBJECT_BYTES) return j(413, { error: "object_too_large", maxBytes: OSS_MAX_OBJECT_BYTES });
      const cap = ossCapFor(sub);
      const usedBytes = ossUsedBytes(sub);
      if (usedBytes + size > cap) {
        return j(429, { error: "oss_quota_exceeded", cap, used: usedBytes });
      }
      const signed = ossPresign("PUT", objectKey, b.contentType || "application/octet-stream");
      const total = ossCharge(sub, size); // meter at sign time (upload commit is fire-and-forget)
      audit("oss.sign", { sub, op, objId, size, monthBytes: total });
      return j(200, { objectKey, ...signed, quota: { cap, used: total } });
    }
    // get: metered too (egress), but never blocked — a paid blob must stay retrievable.
    const size = Math.max(0, Number(b.size || 0));
    if (size) ossCharge(sub, size);
    const signed = ossPresign("GET", objectKey, "");
    audit("oss.sign", { sub, op, objId });
    return j(200, { objectKey, ...signed });
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
