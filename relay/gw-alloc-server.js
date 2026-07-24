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
 *   • one-time pairing bootstrap: first activation gets a short-lived tunnel
 *     entitlement (30 minutes by default) so pairing/health checks can finish.
 *     The actual free trial is an App Store introductory offer and arrives as a
 *     cryptographically verified Apple transaction.
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
const { loadTrustedRoots, verifyAppleJWS } = require("./apple-jws.js");
const { AppleServerAPIClient } = require("./apple-server-api.js");
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
// Public frps endpoint handed to installers by /v1/relay/bootstrap (matches the plugin's
// own `relayAddr` default — kept here so a relay move needs no installer republish).
const FRPS_ADDR = process.env.GW_FRPS_PUBLIC_ADDR || "47.95.195.236:7000";
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
// SEPARATE operator-only bearer for /v1/admin/*.
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
  console.error(
    "FATAL: GW_ALLOC_ADMIN_TOKEN must differ from GW_ALLOC_TOKEN (the split is the point)",
  );
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
// Pairing gets only enough temporary entitlement to complete setup and verify the relay. The
// customer-facing free trial is exclusively Apple's introductory offer, never a server timer.
const BOOTSTRAP_ENABLED = process.env.CP_BOOTSTRAP_ENABLED !== "0";
const configuredBootstrapTtlSec = Number(process.env.CP_BOOTSTRAP_TTL_SEC || 30 * 60);
const BOOTSTRAP_TTL_MS =
  Number.isFinite(configuredBootstrapTtlSec) && configuredBootstrapTtlSec > 0
    ? Math.min(configuredBootstrapTtlSec, 24 * 60 * 60) * 1000
    : 30 * 60_000;
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
const APPLE_SUBSCRIPTION_PRODUCT_ID =
  process.env.APPLE_SUBSCRIPTION_PRODUCT_ID || "SyengUp.FridayNext.Tunnel.yearly";
// Comma/space-separated ISO 3166-1 alpha-3 StoreKit storefront codes. This is deliberately
// operator configuration rather than an app-bundled allowlist: adding a served territory in ASC
// only requires updating this value, and older app builds pick it up on their next refresh.
const APPLE_AVAILABLE_STOREFRONTS_CONFIGURED =
  typeof process.env.APPLE_AVAILABLE_STOREFRONTS === "string";
const APPLE_AVAILABLE_STOREFRONTS = [
  ...new Set(
    String(process.env.APPLE_AVAILABLE_STOREFRONTS || "")
      .split(/[\s,]+/)
      .map((value) => value.trim().toUpperCase())
      .filter((value) => /^[A-Z]{3}$/.test(value)),
  ),
].sort();
if (!APPLE_AVAILABLE_STOREFRONTS_CONFIGURED) {
  console.warn(
    "[cp] APPLE_AVAILABLE_STOREFRONTS not configured — clients fall back to StoreKit catalog availability",
  );
} else if (!APPLE_AVAILABLE_STOREFRONTS.length) {
  console.warn("[cp] APPLE_AVAILABLE_STOREFRONTS is empty — new subscription sales are paused");
}
// Production keeps FridayTunnel's explicit 72-hour service grace. Sandbox compresses a default
// annual subscription to one hour and its billing grace to five minutes, so applying 72 real
// hours there makes every expired test transaction look stuck for three days. Keep it configurable
// for testers that select a different renewal rate in App Store Connect.
const APPLE_PRODUCTION_GRACE_MS = 72 * 3600_000;
const configuredSandboxGraceMs = Number(process.env.APPLE_SANDBOX_GRACE_MS || 5 * 60_000);
const APPLE_SANDBOX_GRACE_MS =
  Number.isFinite(configuredSandboxGraceMs) && configuredSandboxGraceMs >= 0
    ? configuredSandboxGraceMs
    : 5 * 60_000;
const APPLE_ROOT_CA_FILES = process.env.APPLE_ROOT_CA_FILES || "";
let appleTrustedRoots = [];
try {
  appleTrustedRoots = loadTrustedRoots(APPLE_ROOT_CA_FILES);
} catch (error) {
  console.error(`[cp] Apple root certificate load failed: ${error.message}`);
}
if (!appleTrustedRoots.length) {
  console.warn(
    "[cp] APPLE_ROOT_CA_FILES not configured — StoreKit transaction sync and ASSN v2 fail closed",
  );
}
let appleServerAPI = null;
try {
  appleServerAPI = AppleServerAPIClient.fromEnv(process.env);
} catch (error) {
  console.error(`[cp] App Store Server API disabled: ${error.message}`);
}
if (!appleServerAPI) {
  console.warn(
    "[cp] App Store Server API credentials not configured — notification history/current-status reconciliation disabled",
  );
}
const configuredAppleReconcileIntervalSec = Number(
  process.env.APPLE_SERVER_API_RECONCILE_INTERVAL_SEC || 15 * 60,
);
const APPLE_RECONCILE_INTERVAL_MS =
  Number.isFinite(configuredAppleReconcileIntervalSec) && configuredAppleReconcileIntervalSec > 0
    ? Math.max(60, configuredAppleReconcileIntervalSec) * 1000
    : 0;
const configuredAppleReconcileLookbackSec = Number(
  process.env.APPLE_SERVER_API_RECONCILE_LOOKBACK_SEC || 24 * 60 * 60,
);
const APPLE_RECONCILE_LOOKBACK_MS =
  Number.isFinite(configuredAppleReconcileLookbackSec) &&
  configuredAppleReconcileLookbackSec > 0
    ? Math.min(30 * 24 * 60 * 60, configuredAppleReconcileLookbackSec) * 1000
    : 24 * 60 * 60_000;
const APPLE_RECONCILE_OVERLAP_MS = 5 * 60_000;

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
    trialHistory: {}, // appAccountToken → {startedAt, expiresAt}; never deleted/reseeded
    bootstrapHistory: {}, // appAccountToken → {startedAt, expiresAt}; never deleted/reseeded
    // originalTransactionId → last accepted Apple signed transaction metadata. The signedDate
    // monotonic guard makes retries idempotent and prevents an older notification replay from
    // rolling a renewed subscription back to expired/refunded state.
    appleTransactions: {},
    // Production-only, idempotent refund outcomes used by the automatic refund recommendation
    // policy. Transaction IDs are bounded so a long-lived account cannot grow this file forever.
    appleRefundHistory: {},
    // notificationUUID → successful Send Consumption Information response. Notification History
    // deliberately overlaps its cursor, so this durable receipt prevents replaying the same
    // one-shot Apple API call while still allowing a later refund request for the same transaction.
    appleConsumptionResponses: {},
    // App Store Server API history cursors. Each successful run overlaps five minutes so a
    // notification racing the end boundary cannot fall between adjacent windows.
    appleReconciliation: {},
    // D31 per-Apple-ID subdomains: `${gatewayKey}:${appAccountToken}` → subdomain. The FIRST
    // Apple ID on a gateway reuses the gateway's base subdomain (registry[gatewayKey]); each
    // ADDITIONAL Apple ID gets its own. The gateway polls /v1/gateway/subdomains to learn which
    // to run an frpc proxy for, so an un-granted Apple ID simply has no reachable subdomain.
    appleSubs: {},
    // gatewayKey → stable standby identity. Contains no bearer or user data: only the allocated
    // base subdomain and the gateway TLS public-key pin needed for remote first activation.
    gateways: {},
    attestKeys: {}, // keyId → {publicKey, signCount, environment, deviceId, createdAt}
    revoked: [], // [subdomain] — rejected at the frps gate on next registration
    killswitch: false, // emergency: reject ALL FridayNext-namespace registrations
    ossUsage: {}, // subdomain → { month: "2026-07", bytes } — sign-time traffic accounting
  },
  loadJsonStrict(CP_STATE, {}),
);
cp.appleTransactions ||= {};
cp.appleRefundHistory ||= {};
cp.appleConsumptionResponses ||= {};
cp.appleReconciliation ||= {};
cp.trialHistory ||= {};
cp.bootstrapHistory ||= {};
cp.gateways ||= {};
function saveCp() {
  saveJson(CP_STATE, cp);
}

// Fold persisted per-Apple-ID subdomains into the gate's allocated set (see note by `used`).
for (const sub of Object.values(cp.appleSubs || {})) used.add(sub);

// One-time attest nonces (P2-19) — in-memory is fine: 5-min TTL, and a relay restart
// invalidating outstanding nonces just means one extra round-trip for the client.
const attestNonces = new Map(); // nonce → expiresAt(ms)

// Held HTTP standby waiters. A grant/revocation resolves them immediately; a 25s timeout keeps
// intermediaries happy and makes missed notifications self-healing without a WebSocket protocol.
const gatewayStandbyWaiters = new Map(); // gatewayKey → Set<resolve>

function desiredSubdomainsForGateway(gatewayKey, enforce = ENFORCE_GRANTS) {
  if (cp.killswitch) return [];
  const prefix = `${gatewayKey}:`;
  const active = [];
  for (const [mapKey, sub] of Object.entries(cp.appleSubs)) {
    if (!mapKey.startsWith(prefix) || cp.revoked.includes(sub)) continue;
    if (!enforce || appleSubActive(sub)) active.push(sub);
  }
  const baseSub = registry[gatewayKey];
  if (
    baseSub &&
    !cp.revoked.includes(baseSub) &&
    !active.includes(baseSub) &&
    (!enforce || appleSubActive(baseSub))
  ) {
    active.push(baseSub);
  }
  return [...new Set(active)].sort();
}

function gatewayDesiredRevision(
  gatewayKey,
  subdomains = desiredSubdomainsForGateway(gatewayKey, true),
) {
  return crypto
    .createHash("sha256")
    .update(`${gatewayKey}\n${cp.killswitch ? "1" : "0"}\n${subdomains.join("\n")}`)
    .digest("hex")
    .slice(0, 24);
}

function notifyGatewayStandby(gatewayKey) {
  const keys = gatewayKey ? [gatewayKey] : [...gatewayStandbyWaiters.keys()];
  for (const key of keys) {
    const waiters = gatewayStandbyWaiters.get(key);
    if (!waiters) continue;
    gatewayStandbyWaiters.delete(key);
    for (const resolve of waiters) resolve();
  }
}

function waitForGatewayDesiredChange(gatewayKey, waitMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const waiters = gatewayStandbyWaiters.get(gatewayKey);
      waiters?.delete(finish);
      if (waiters?.size === 0) gatewayStandbyWaiters.delete(gatewayKey);
      resolve();
    };
    const timer = setTimeout(finish, waitMs);
    const waiters = gatewayStandbyWaiters.get(gatewayKey) || new Set();
    waiters.add(finish);
    gatewayStandbyWaiters.set(gatewayKey, waiters);
  });
}

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
  audit("apple-sub.assign", {
    gatewayKey: gatewayKey.slice(0, 12),
    subdomain: sub,
    reused: sub === baseSub,
  });
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
// Entitlement (D8) + short pairing bootstrap.
// ---------------------------------------------------------------------------
function entitled(appAccountToken) {
  normalizeLegacyServerTrial(appAccountToken);
  const s = cp.subs[appAccountToken];
  normalizeAppleSubscription(s);
  if (
    s &&
    ["bootstrap", "trial", "active", "grace"].includes(s.state) &&
    (!s.expiresAt || s.expiresAt > now())
  )
    return true;
  return false;
}

function appleGraceMs(subscription) {
  const transaction = subscription?.originalTransactionId
    ? cp.appleTransactions[subscription.originalTransactionId]
    : null;
  const environment = subscription?.environment || transaction?.environment;
  return environment === "Sandbox" ? APPLE_SANDBOX_GRACE_MS : APPLE_PRODUCTION_GRACE_MS;
}

/** Move an Apple subscription through active → grace → expired even if no notification
 * arrives at the exact boundary. Apple notifications still update it eagerly; this is the
 * fail-safe consulted by verify, grant renewal and the frps gate. */
function normalizeAppleSubscription(subscription) {
  if (!subscription || subscription.source !== "apple" || !subscription.billingExpiresAt) return;
  const previousState = subscription.state;
  const billingEnd = Number(subscription.billingExpiresAt);
  if (!Number.isFinite(billingEnd)) return;
  const graceMs = appleGraceMs(subscription);
  const graceEnd = billingEnd + graceMs;
  if (["trial", "active"].includes(subscription.state) && billingEnd <= now()) {
    subscription.state = now() < graceEnd ? "grace" : "expired";
    subscription.expiresAt = graceEnd;
  }
  if (subscription.state === "grace") {
    // Migrate records written before environment-aware grace existed. Their persisted expiresAt
    // may still be billingEnd+72h even though the underlying transaction is Sandbox.
    subscription.expiresAt = graceEnd;
    if (graceEnd <= now()) subscription.state = "expired";
  }
  if (subscription.state !== previousState) {
    if (subscription.state === "expired" && subscription.originalTransactionId) {
      const transaction = cp.appleTransactions[subscription.originalTransactionId];
      if (transaction?.appAccountToken) removeAccountGrants(transaction.appAccountToken, "expired");
    }
    saveCp();
    audit("apple.subscription_transition", { from: previousState, to: subscription.state });
  }
}

function grantEntitlementCeiling(subscription) {
  if (!subscription?.expiresAt) return Infinity;
  const grace =
    ["trial", "active"].includes(subscription.state) && subscription.source === "apple"
      ? appleGraceMs(subscription)
      : 0;
  return Number(subscription.expiresAt) + grace;
}

/** Clamp beta/server-trial rows created by older builds to the new short bootstrap window.
 * Apple introductory trials and activation-code grants are deliberately untouched. */
function normalizeLegacyServerTrial(appAccountToken) {
  if (!appAccountToken) return;
  const s = cp.subs[appAccountToken];
  if (
    !s ||
    s.state !== "trial" ||
    !["free-test", "server-trial"].includes(String(s.source || ""))
  ) {
    return;
  }

  const migratedAt = now();
  const legacyExpiry = Number(s.expiresAt);
  const expiresAt =
    Number.isFinite(legacyExpiry) && legacyExpiry <= migratedAt
      ? legacyExpiry
      : Math.min(
          Number.isFinite(legacyExpiry) ? legacyExpiry : Infinity,
          migratedAt + BOOTSTRAP_TTL_MS,
        );
  s.state = expiresAt > migratedAt ? "bootstrap" : "expired";
  s.source = "pairing-bootstrap-migrated";
  s.startedAt = migratedAt;
  s.expiresAt = expiresAt;
  let grantsClamped = 0;
  for (const grant of Object.values(cp.grants)) {
    if (grant.appAccountToken !== appAccountToken || Number(grant.expiresAt) <= expiresAt) continue;
    grant.expiresAt = expiresAt;
    grantsClamped++;
  }
  cp.bootstrapHistory[appAccountToken] ||= { startedAt: migratedAt, expiresAt };
  saveCp();
  audit("trial.migrate_to_bootstrap", { appAccountToken, expiresAt, grantsClamped });
}

/** Seed the one-time pairing bootstrap. This is called only by tunnel activation: verifying a
 * subscription, renewing a grant or signing an attachment can never manufacture entitlement. */
function ensureBootstrapEntitlement(appAccountToken) {
  if (!appAccountToken) return;
  normalizeLegacyServerTrial(appAccountToken);
  if (
    !BOOTSTRAP_ENABLED ||
    cp.subs[appAccountToken] ||
    cp.bootstrapHistory[appAccountToken]
  ) {
    return;
  }
  const startedAt = now();
  const expiresAt = startedAt + BOOTSTRAP_TTL_MS;
  cp.subs[appAccountToken] = {
    state: "bootstrap",
    startedAt,
    expiresAt,
    source: "pairing-bootstrap",
  };
  cp.bootstrapHistory[appAccountToken] = { startedAt, expiresAt };
  saveCp();
  audit("bootstrap.seed", { appAccountToken, expiresAt });
}

// Rollout migration is eager so dormant beta accounts do not keep a misleading 30-day row until
// their next app open. Active proxies are still cut through the normal entitlement boundary sweep.
for (const appAccountToken of Object.keys(cp.subs)) {
  normalizeLegacyServerTrial(appAccountToken);
}
let bootstrapGrantsClampedAtStartup = 0;
for (const grant of Object.values(cp.grants)) {
  const subscription = cp.subs[grant.appAccountToken];
  if (
    subscription?.state !== "bootstrap" ||
    !Number.isFinite(Number(subscription.expiresAt)) ||
    Number(grant.expiresAt) <= Number(subscription.expiresAt)
  ) {
    continue;
  }
  grant.expiresAt = Number(subscription.expiresAt);
  bootstrapGrantsClampedAtStartup++;
}
if (bootstrapGrantsClampedAtStartup) {
  saveCp();
  audit("bootstrap.grants_clamped", { count: bootstrapGrantsClampedAtStartup });
}

function removeAccountGrants(appAccountToken, reason) {
  let removed = 0;
  for (const [grantId, grant] of Object.entries(cp.grants)) {
    if (grant.appAccountToken !== appAccountToken) continue;
    delete cp.grants[grantId];
    removed++;
  }
  if (removed) forceProxyReregistration(`apple:${reason}:${appAccountToken.slice(0, 8)}`);
  if (removed) notifyGatewayStandby();
  return removed;
}

function normalizeAppleAccountToken(value) {
  const token = String(value || "").toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      token,
    )
  ) {
    throw new Error("invalid_app_account_token");
  }
  return token;
}

function appleOriginalTransactionId(payload) {
  return String(payload.originalTransactionId || payload.transactionId || "");
}

/**
 * Offer Code redemption can produce a valid StoreKit transaction without `appAccountToken`
 * because Apple's system redemption sheet doesn't accept purchase options. Bind that transaction
 * on the first authenticated client sync, then pin every renewal/notification to the durable
 * originalTransactionId owner. A transaction that does carry Apple's token remains authoritative.
 */
function resolveAppleTransactionOwner(payload, claimedAppAccountToken) {
  const originalTransactionId = appleOriginalTransactionId(payload);
  if (!originalTransactionId) throw new Error("invalid_transaction_identity");
  const embedded = payload.appAccountToken
    ? normalizeAppleAccountToken(payload.appAccountToken)
    : null;
  const claimed = claimedAppAccountToken
    ? normalizeAppleAccountToken(claimedAppAccountToken)
    : null;
  const bound = cp.appleTransactions[originalTransactionId]?.appAccountToken
    ? normalizeAppleAccountToken(cp.appleTransactions[originalTransactionId].appAccountToken)
    : null;

  if (embedded && claimed && embedded !== claimed) throw new Error("app_account_token_mismatch");
  if (bound && embedded && bound !== embedded) throw new Error("apple_transaction_owner_conflict");
  if (bound && claimed && bound !== claimed) throw new Error("apple_transaction_owner_conflict");
  const appAccountToken = embedded || bound || claimed;
  if (!appAccountToken) throw new Error("unbound_app_account_token");
  return {
    appAccountToken,
    firstBind: !embedded && !bound && Boolean(claimed),
    source: embedded ? "apple" : bound ? "original_transaction" : "signed_jws_first_bind",
  };
}

/** Apply a cryptographically verified App Store transaction to the anonymous entitlement row. */
function applyAppleTransaction(
  payload,
  notificationType = "CLIENT_SYNC",
  resolvedAppAccountToken,
) {
  const appAccountToken = normalizeAppleAccountToken(
    resolvedAppAccountToken || payload.appAccountToken,
  );
  const originalTransactionId = String(
    payload.originalTransactionId || payload.transactionId || "",
  );
  const transactionId = String(payload.transactionId || "");
  const signedDate = Number(payload.signedDate || 0);
  const expiresDate = Number(payload.expiresDate || 0);
  const offerType = Number(payload.offerType || 0);
  const environment = payload.environment || "unknown";
  const graceMs =
    environment === "Sandbox" ? APPLE_SANDBOX_GRACE_MS : APPLE_PRODUCTION_GRACE_MS;
  if (!originalTransactionId || !transactionId || !Number.isFinite(signedDate) || !signedDate) {
    throw new Error("invalid_transaction_identity");
  }
  const previous = cp.appleTransactions[originalTransactionId];
  if (previous && Number(previous.signedDate) > signedDate) {
    return { appAccountToken, replayed: true };
  }

  let state;
  let entitlementEnd;
  const revoked =
    Boolean(payload.revocationDate) || ["REFUND", "REVOKE"].includes(notificationType);
  if (revoked) {
    state = "refunded";
    entitlementEnd = now();
  } else if (notificationType === "GRACE_PERIOD_EXPIRED") {
    state = "expired";
    entitlementEnd = now();
  } else if (expiresDate > now()) {
    state = offerType === 1 ? "trial" : "active";
    entitlementEnd = expiresDate;
  } else if (expiresDate && expiresDate + graceMs > now()) {
    state = "grace";
    entitlementEnd = expiresDate + graceMs;
  } else {
    state = "expired";
    entitlementEnd = expiresDate || now();
  }

  cp.appleTransactions[originalTransactionId] = {
    transactionId,
    signedDate,
    appAccountToken,
    expiresDate,
    environment,
    offerType: offerType || undefined,
  };
  cp.subs[appAccountToken] = {
    state,
    expiresAt: entitlementEnd,
    billingExpiresAt: expiresDate || undefined,
    source: "apple",
    originalTransactionId,
    environment,
    offerType: offerType || undefined,
  };
  const removedGrants = ["expired", "refunded"].includes(state)
    ? removeAccountGrants(appAccountToken, state)
    : 0;
  saveCp();
  audit("apple.transaction", {
    notificationType,
    appAccountToken,
    originalTransactionId,
    transactionId,
    state,
    removedGrants,
  });
  return {
    appAccountToken,
    originalTransactionId,
    transactionId,
    state,
    replayed: false,
  };
}

function verifyTransactionJWS(signedTransaction, appAccountToken) {
  return verifyAppleJWS(signedTransaction, {
    trustedRoots: appleTrustedRoots,
    bundleId: APP_ATTEST_BUNDLE_ID,
    productId: APPLE_SUBSCRIPTION_PRODUCT_ID,
    appAccountToken,
  });
}

/**
 * Shared ASSN v2 processor for the live webhook and Get Notification History recovery.
 * Both paths re-verify the outer and nested JWS; history is transport, never trust.
 */
function applyAppleSignedNotification(signedPayload, source = "webhook") {
  const notification = verifyAppleJWS(signedPayload, { trustedRoots: appleTrustedRoots });
  if (notification.data?.bundleId !== APP_ATTEST_BUNDLE_ID) throw new Error("bundle_mismatch");
  const signedTransaction = notification.data?.signedTransactionInfo;
  if (!signedTransaction) {
    audit("apple.notification_ignored", {
      source,
      notificationType: notification.notificationType,
      notificationUUID: notification.notificationUUID,
    });
    return {
      ok: true,
      ignored: true,
      notificationType: notification.notificationType,
      notificationUUID: notification.notificationUUID,
    };
  }

  const transaction = verifyTransactionJWS(signedTransaction);
  let ownership;
  try {
    ownership = resolveAppleTransactionOwner(transaction);
  } catch (error) {
    if (error.message !== "unbound_app_account_token") throw error;
    // Apple can notify before a code redeemer opens the app. There is no FridayNext identity
    // in that payload to bind yet, so acknowledge it and let the verified client transaction
    // establish the owner. Subsequent notifications resolve through originalTransactionId.
    audit("apple.notification_ignored", {
      source,
      notificationType: notification.notificationType,
      notificationUUID: notification.notificationUUID,
      reason: "offer_code_waiting_for_client_bind",
      originalTransactionId: appleOriginalTransactionId(transaction),
    });
    return {
      ok: true,
      ignored: true,
      notificationType: notification.notificationType,
      notificationUUID: notification.notificationUUID,
    };
  }

  const applied = applyAppleTransaction(
    transaction,
    notification.notificationType,
    ownership.appAccountToken,
  );
  audit("apple.notification", {
    source,
    notificationType: notification.notificationType,
    notificationUUID: notification.notificationUUID,
    appAccountToken: applied.appAccountToken,
  });
  return {
    ok: true,
    ignored: false,
    notificationType: notification.notificationType,
    notificationUUID: notification.notificationUUID,
    appAccountToken: applied.appAccountToken,
    originalTransactionId: applied.originalTransactionId,
    transactionId: applied.transactionId,
    environment: notification.data?.environment,
    consumptionRequestReason: notification.data?.consumptionRequestReason,
  };
}

const APPLE_REFUND_HISTORY_LIMIT = 20;
const APPLE_REFUND_PREFERENCES = new Set(["GRANT_FULL", "GRANT_PRORATED", "DECLINE"]);
const APPLE_CONSUMPTION_RESPONSE_HISTORY_LIMIT = 2_000;
const appleConsumptionResponsesInFlight = new Set();

function appleRefundHistory(appAccountToken) {
  const history = cp.appleRefundHistory[appAccountToken] || {};
  return {
    approvedTransactionIds: Array.isArray(history.approvedTransactionIds)
      ? history.approvedTransactionIds
      : [],
    declinedTransactionIds: Array.isArray(history.declinedTransactionIds)
      ? history.declinedTransactionIds
      : [],
  };
}

function appendUniqueBounded(values, value) {
  if (!value || values.includes(value)) return values;
  return [...values, value].slice(-APPLE_REFUND_HISTORY_LIMIT);
}

function recordAppleRefundOutcome(result, source) {
  if (
    result.ignored ||
    result.environment !== "Production" ||
    !["REFUND", "REFUND_DECLINED"].includes(result.notificationType) ||
    !result.appAccountToken ||
    !result.transactionId
  ) {
    return;
  }
  const history = appleRefundHistory(result.appAccountToken);
  const field =
    result.notificationType === "REFUND"
      ? "approvedTransactionIds"
      : "declinedTransactionIds";
  const updated = appendUniqueBounded(history[field], result.transactionId);
  if (updated === history[field]) return;
  history[field] = updated;
  cp.appleRefundHistory[result.appAccountToken] = history;
  saveCp();
  audit("apple.refund_outcome_recorded", {
    source,
    notificationType: result.notificationType,
    appAccountToken: result.appAccountToken,
    transactionId: result.transactionId,
    approvedRefundCount: history.approvedTransactionIds.length,
    declinedRefundCount: history.declinedTransactionIds.length,
  });
}

/**
 * Production refund recommendation policy.
 *
 * We deliberately don't infer "usage" from attachment traffic: FridayTunnel doesn't inspect
 * tunnel payloads, and OSS bytes cover only signed attachments. A successfully activated tunnel
 * is the only reliable product-use signal currently available.
 *
 * Apple makes the final decision. Omitting refundPreference is an explicit neutral response.
 */
function appleRefundConsumptionDecision(result) {
  const appAccountToken = result.appAccountToken;
  const hasActivatedTunnel = Object.values(cp.tunnels).some(
    (tunnel) => tunnel.appAccountToken === appAccountToken,
  );
  if (result.environment === "Sandbox") {
    return {
      deliveryStatus: "DELIVERED",
      refundPreference: "GRANT_FULL",
      policyReason: "sandbox_test",
      hasActivatedTunnel,
      priorApprovedRefunds: 0,
    };
  }

  const history = appleRefundHistory(appAccountToken);
  const priorApprovedRefunds = history.approvedTransactionIds.length;
  const operatorOverride = String(
    process.env.APPLE_PRODUCTION_REFUND_PREFERENCE || "",
  ).trim();

  if (APPLE_REFUND_PREFERENCES.has(operatorOverride)) {
    return {
      deliveryStatus: cp.killswitch ? "UNDELIVERED_SERVER_OUTAGE" : "DELIVERED",
      refundPreference: operatorOverride,
      policyReason: "operator_override",
      hasActivatedTunnel,
      priorApprovedRefunds,
    };
  }
  if (cp.killswitch) {
    return {
      deliveryStatus: "UNDELIVERED_SERVER_OUTAGE",
      refundPreference: "GRANT_FULL",
      policyReason: "service_outage",
      hasActivatedTunnel,
      priorApprovedRefunds,
    };
  }
  if (result.consumptionRequestReason === "LEGAL") {
    return {
      deliveryStatus: "DELIVERED",
      refundPreference: "GRANT_FULL",
      policyReason: "legal_request",
      hasActivatedTunnel,
      priorApprovedRefunds,
    };
  }
  if (!hasActivatedTunnel) {
    return {
      deliveryStatus: "DELIVERED",
      refundPreference: "GRANT_FULL",
      policyReason: "never_activated",
      hasActivatedTunnel,
      priorApprovedRefunds,
    };
  }
  if (priorApprovedRefunds >= 2) {
    return {
      deliveryStatus: "DELIVERED",
      refundPreference: "DECLINE",
      policyReason: "repeated_refunds",
      hasActivatedTunnel,
      priorApprovedRefunds,
    };
  }
  return {
    deliveryStatus: "DELIVERED",
    refundPreference: undefined,
    policyReason: "apple_decides",
    hasActivatedTunnel,
    priorApprovedRefunds,
  };
}

function recordAppleConsumptionResponse(result, decision) {
  const notificationUUID = String(result.notificationUUID || "");
  if (!notificationUUID) return;
  cp.appleConsumptionResponses[notificationUUID] = {
    environment: result.environment,
    transactionId: result.transactionId,
    respondedAt: now(),
    refundPreference: decision.refundPreference || undefined,
    policyReason: decision.policyReason,
  };
  const notificationUUIDs = Object.keys(cp.appleConsumptionResponses);
  for (
    let index = 0;
    index < notificationUUIDs.length - APPLE_CONSUMPTION_RESPONSE_HISTORY_LIMIT;
    index++
  ) {
    delete cp.appleConsumptionResponses[notificationUUIDs[index]];
  }
  saveCp();
}

async function respondToAppleConsumptionRequest(result, source) {
  if (result.notificationType !== "CONSUMPTION_REQUEST") return;
  const notificationUUID = String(result.notificationUUID || "");
  if (notificationUUID && cp.appleConsumptionResponses[notificationUUID]) {
    audit("apple.consumption_response_skipped", {
      source,
      environment: result.environment,
      transactionId: result.transactionId,
      notificationUUID,
      reason: "already_responded",
    });
    return;
  }
  if (notificationUUID && appleConsumptionResponsesInFlight.has(notificationUUID)) {
    audit("apple.consumption_response_skipped", {
      source,
      environment: result.environment,
      transactionId: result.transactionId,
      notificationUUID,
      reason: "response_in_flight",
    });
    return;
  }
  if (!appleServerAPI) {
    audit("apple.consumption_response_failed", {
      source,
      environment: result.environment,
      transactionId: result.transactionId,
      reason: "apple_server_api_not_configured",
    });
    return;
  }
  const decision = appleRefundConsumptionDecision(result);
  const body = {
    // Apple only sends this request after the customer consents in its refund sheet.
    customerConsented: true,
    deliveryStatus: decision.deliveryStatus,
    // FridayTunnel explains its operation before purchase and offers an introductory trial.
    sampleContentProvided: true,
  };
  if (decision.refundPreference) body.refundPreference = decision.refundPreference;
  if (notificationUUID) appleConsumptionResponsesInFlight.add(notificationUUID);
  try {
    await appleServerAPI.sendConsumptionInformation(
      result.environment,
      result.transactionId,
      body,
    );
    recordAppleConsumptionResponse(result, decision);
    audit("apple.consumption_response_accepted", {
      source,
      environment: result.environment,
      transactionId: result.transactionId,
      notificationUUID,
      refundPreference: decision.refundPreference || "NO_PREFERENCE",
      deliveryStatus: decision.deliveryStatus,
      policyReason: decision.policyReason,
      hasActivatedTunnel: decision.hasActivatedTunnel,
      priorApprovedRefunds: decision.priorApprovedRefunds,
      consumptionRequestReason: result.consumptionRequestReason,
    });
  } catch (error) {
    audit("apple.consumption_response_failed", {
      source,
      environment: result.environment,
      transactionId: result.transactionId,
      notificationUUID,
      status: error.status,
      retryable: error.retryable,
      reason: error.message || String(error),
    });
    throw error;
  } finally {
    if (notificationUUID) appleConsumptionResponsesInFlight.delete(notificationUUID);
  }
}

async function processAppleSignedNotification(signedPayload, source = "webhook") {
  const result = applyAppleSignedNotification(signedPayload, source);
  await respondToAppleConsumptionRequest(result, source);
  recordAppleRefundOutcome(result, source);
  return result;
}

function appleReconcileEnvironments(requested) {
  if (requested === "Production" || requested === "Sandbox") return [requested];
  return ["Production", "Sandbox"];
}

async function reconcileAppleNotificationHistory(environment, endDate) {
  const cursor = cp.appleReconciliation[environment] || {};
  const earliest = endDate - APPLE_RECONCILE_LOOKBACK_MS;
  const previousEnd = Number(cursor.lastSuccessfulEnd || 0);
  const startDate = previousEnd
    ? Math.max(earliest, previousEnd - APPLE_RECONCILE_OVERLAP_MS)
    : earliest;
  const body = { startDate, endDate, onlyFailures: false };
  let paginationToken;
  let pages = 0;
  let processed = 0;
  let ignored = 0;
  let rejected = 0;

  do {
    if (++pages > 500) throw new Error("apple_notification_history_page_limit");
    const response = await appleServerAPI.getNotificationHistory(
      environment,
      body,
      paginationToken,
    );
    for (const item of response.notificationHistory || []) {
      if (!item?.signedPayload) {
        rejected++;
        audit("apple.reconcile_notification_rejected", {
          environment,
          reason: "missing_signed_payload",
        });
        continue;
      }
      try {
        const result = await processAppleSignedNotification(item.signedPayload, "history");
        if (result.ignored) ignored++;
        else processed++;
      } catch (error) {
        // One malformed historical record must not permanently pin the cursor. It is rejected
        // without mutation; the current-status pass below remains the entitlement authority.
        rejected++;
        audit("apple.reconcile_notification_rejected", {
          environment,
          reason: error.message || String(error),
        });
      }
    }
    paginationToken = response.hasMore ? response.paginationToken : undefined;
    if (response.hasMore && !paginationToken) {
      throw new Error("apple_notification_history_missing_pagination_token");
    }
  } while (paginationToken);

  cp.appleReconciliation[environment] = {
    ...cursor,
    lastSuccessfulStart: startDate,
    lastSuccessfulEnd: endDate,
    lastHistoryPages: pages,
    lastHistoryProcessed: processed,
    lastHistoryIgnored: ignored,
    lastHistoryRejected: rejected,
  };
  saveCp();
  return { pages, processed, ignored, rejected, startDate, endDate };
}

function signedTransactionsFromStatusResponse(response) {
  const result = [];
  for (const group of response?.data || []) {
    for (const item of group?.lastTransactions || []) {
      if (typeof item?.signedTransactionInfo === "string") {
        result.push(item.signedTransactionInfo);
      }
    }
  }
  return result;
}

async function reconcileAppleCurrentStatuses(environment) {
  const known = Object.entries(cp.appleTransactions).filter(
    ([, transaction]) => transaction?.environment === environment,
  );
  let queried = 0;
  let applied = 0;
  let failed = 0;
  for (const [originalTransactionId] of known) {
    try {
      const response = await appleServerAPI.getAllSubscriptionStatuses(
        environment,
        originalTransactionId,
      );
      if (response.bundleId && response.bundleId !== APP_ATTEST_BUNDLE_ID) {
        throw new Error("bundle_mismatch");
      }
      queried++;
      for (const signedTransaction of signedTransactionsFromStatusResponse(response)) {
        try {
          const transaction = verifyTransactionJWS(signedTransaction);
          const ownership = resolveAppleTransactionOwner(transaction);
          applyAppleTransaction(transaction, "SERVER_RECONCILE", ownership.appAccountToken);
          applied++;
        } catch (error) {
          // A future second IAP in the same subscription group must not poison reconciliation
          // for FridayTunnel's pinned product.
          if (error.message === "product_mismatch") continue;
          throw error;
        }
      }
    } catch (error) {
      failed++;
      audit("apple.reconcile_status_failed", {
        environment,
        originalTransactionId,
        status: error.status,
        retryable: error.retryable,
        reason: error.message || String(error),
      });
    }
  }
  return { known: known.length, queried, applied, failed };
}

let appleReconcileInFlight = null;
function runAppleReconciliation(requestedEnvironment) {
  if (!appleServerAPI) return Promise.reject(new Error("apple_server_api_not_configured"));
  if (appleReconcileInFlight) return appleReconcileInFlight;
  appleReconcileInFlight = (async () => {
    const startedAt = now();
    const environments = appleReconcileEnvironments(requestedEnvironment);
    const summaries = {};
    for (const environment of environments) {
      const history = await reconcileAppleNotificationHistory(environment, now());
      const currentStatuses = await reconcileAppleCurrentStatuses(environment);
      summaries[environment] = { history, currentStatuses };
    }
    const durationMs = now() - startedAt;
    audit("apple.reconcile_complete", { environments, durationMs, summaries });
    return { ok: true, durationMs, environments: summaries };
  })()
    .catch((error) => {
      audit("apple.reconcile_failed", {
        environment: requestedEnvironment,
        status: error.status,
        retryable: error.retryable,
        reason: error.message || String(error),
      });
      throw error;
    })
    .finally(() => {
      appleReconcileInFlight = null;
    });
  return appleReconcileInFlight;
}

async function verifyAppleClientAttest(body, payload) {
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
  let challenge = `apple:${String(payload.transactionId || "")}`;
  if (typeof body.attestNonce === "string" && body.attestNonce) {
    const expiresAt = attestNonces.get(body.attestNonce);
    attestNonces.delete(body.attestNonce);
    if (!expiresAt || expiresAt < now()) {
      return { verified: false, reason: "stale_nonce", invalid: true };
    }
    challenge = body.attestNonce;
  } else if (ATTEST_REQUIRE && body.attestation) {
    return { verified: false, reason: "missing_nonce", invalid: true };
  }
  return verifyActivationAttest(body.attestation, challenge, deviceId);
}

function subscriptionResponse(appAccountToken) {
  normalizeLegacyServerTrial(appAccountToken);
  const s = cp.subs[appAccountToken];
  if (!s) {
    return {
      state: "none",
      entitled: false,
      availableStorefronts: APPLE_AVAILABLE_STOREFRONTS_CONFIGURED
        ? APPLE_AVAILABLE_STOREFRONTS
        : undefined,
    };
  }
  normalizeAppleSubscription(s);
  return {
    state: s.state,
    entitled: entitled(appAccountToken),
    expiresAt: s.expiresAt,
    availableStorefronts: APPLE_AVAILABLE_STOREFRONTS_CONFIGURED
      ? APPLE_AVAILABLE_STOREFRONTS
      : undefined,
  };
}

function issueGrant(appAccountToken, tunnelId, deviceId, attested) {
  const grantId = rid();
  const subscription = cp.subs[appAccountToken];
  normalizeAppleSubscription(subscription);
  // A newly-issued grant must not recreate the old "renew on the eve of expiry, keep 30 days"
  // loophole. Paid/code subscriptions get the same 72h grace as renewGrant; trial does not.
  const entitlementCeiling = grantEntitlementCeiling(subscription);
  cp.grants[grantId] = {
    appAccountToken,
    tunnelId,
    deviceId,
    expiresAt: Math.min(now() + 30 * DAY, entitlementCeiling),
    attested,
  };
  saveCp();
  notifyGatewayStandby();
  return grantId;
}

/** Normalize an activate `subdomain` (bare "fnabc…" or full FQDN) to the bare label. */
function bareSubdomain(input) {
  const s = String(input || "")
    .trim()
    .toLowerCase();
  if (!s) return "";
  return s.endsWith("." + SUBDOMAIN_HOST) ? s.slice(0, -(SUBDOMAIN_HOST.length + 1)) : s;
}

function subdomainHasActiveGrant(sub) {
  for (const g of Object.values(cp.grants)) {
    const t = cp.tunnels[g.tunnelId];
    if (t && t.subdomain === sub && g.expiresAt > now() && entitled(g.appAccountToken)) return true;
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
    else
      console.log(
        `[enforce] frps restarted (${reason}) — all proxies re-register through the gate`,
      );
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
      (sub) => !subdomainHasActiveGrant(sub) && !subdomainHasEntitledOwner(sub),
    );
    if (!stale.length) return;
    if (now() - lastFrpsRestartAt < EXPIRY_SWEEP_RESTART_COOLDOWN_MS) return;
    audit("enforce.sweep", { stale });
    forceProxyReregistration(`expiry-sweep:${stale.join(",")}`);
  }, EXPIRY_SWEEP_INTERVAL_MS);
  sweep.unref?.();
}

// ---------------------------------------------------------------------------
// State GC — cp-state only ever grew (expired reservations/grants, past-month OSS
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
  // Old deployments may still contain retired activation-code rows. They are never redeemable,
  // but can age out naturally without making the state-file migration destructive.
  for (const [code, c] of Object.entries(cp.codes || {})) {
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
  return Boolean(
    OSS_MOCK_BASE || (OSS_BUCKET && OSS_ENDPOINT && OSS_ACCESS_KEY_ID && OSS_ACCESS_KEY_SECRET),
  );
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
  const signature = crypto
    .createHmac("sha1", OSS_ACCESS_KEY_SECRET)
    .update(stringToSign)
    .digest("base64");
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
        "certonly",
        "--non-interactive",
        "--agree-tos",
        "-m",
        ACME_EMAIL,
        "--webroot",
        "-w",
        WEBROOT,
        "--csr",
        csrPath,
        "--cert-path",
        certPath,
        "--fullchain-path",
        fullPath,
        "--chain-path",
        chainPath,
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
      audit("gate.reject", {
        proxy: content.proxy_name,
        sub: effectiveSub,
        reason: "no_active_grant",
      });
      gateAllowedSubs.delete(effectiveSub);
      return reply({ reject: true, reject_reason: "no active grant (subscription expired?)" });
    }

    gateAllowedSubs.set(effectiveSub, now()); // feeds the ENFORCE_GRANTS expiry sweep

    // Accept + inject a server-enforced bandwidth cap. Echo the received content
    // verbatim so frp re-parses a well-formed config, overriding only the cap.
    content.bandwidth_limit = BW_LIMIT;
    content.bandwidth_limit_mode = "server";
    console.log(
      `[frp-gate] allow proxy=${content.proxy_name} sub=${sub || domains.join(",")} bw=${BW_LIMIT}`,
    );
    return reply({ reject: false, unchange: false, content });
  });
});
frpGate.listen(FRP_GATE_PORT, HOST, () =>
  console.log(`gw-alloc (frp-gate) on ${HOST}:${FRP_GATE_PORT}`),
);

// ---------------------------------------------------------------------------
// Control plane /v1 (port 7003) — the production mock-control-plane.mjs.
// Wire contract: docs/public-access-contract.md §2 (Swift DTOs decode these
// exact shapes). Public endpoints authenticate via appAccountToken + attest, not
// bearer. App Store webhooks authenticate exclusively through Apple's JWS chain.
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
    return j(200, {
      ok: true,
      uptimeSec: Math.floor(process.uptime()),
      killswitch: cp.killswitch,
      appleServerAPIConfigured: Boolean(appleServerAPI),
    });
  }

  // —— relay bootstrap (no auth, ON PURPOSE) ——
  // The installer needs `relayToken` (= GW_ALLOC_TOKEN = frps auth.token) before it can bring a
  // tunnel up, and that token is the very thing /allocate is guarded by — a chicken-and-egg the
  // beta line previously solved by hand-editing openclaw.json.
  //
  // Serving it unauthenticated is a DELIBERATE, BOUNDED choice:
  //  · this token is already semi-public by design — it sits in plaintext on every user gateway;
  //  · frps registration is not the security boundary — the NewProxy gate is: a stranger holding
  //    this token still cannot claim a subdomain that isn't allocated to their gateway key;
  //  · it lives HERE, not in the open-source installer, so it can be rotated or retired later
  //    WITHOUT republishing an installer that is already on users' machines.
  // Keep this on for new pairing. `/gateway/subdomains` + NewProxy are the entitlement boundary;
  // GW_RELAY_BOOTSTRAP=0 is an emergency provisioning stop, not the paid-launch switch.
  if (p === "/v1/relay/bootstrap") {
    if (process.env.GW_RELAY_BOOTSTRAP === "0") return j(404, { error: "not found" });
    console.log(`[bootstrap] relay credentials served → ${req.socket.remoteAddress ?? "?"}`);
    return j(200, { relayAddr: FRPS_ADDR, relayToken: TOKEN, subDomainHost: SUBDOMAIN_HOST });
  }

  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  // Admin surfaces take ONLY the operator token — never GW_ALLOC_TOKEN, which every user
  // gateway holds (see the token-split note at the top).
  const isAdmin = tokenEqual(bearer, ADMIN_TOKEN);

  // ————— admin/ops (bearer) —————
  if (p.startsWith("/v1/admin/")) {
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
    notifyGatewayStandby();
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
    notifyGatewayStandby();
    audit("admin.unrevoke", { subdomain: sub });
    return j(200, { ok: true, revoked: cp.revoked });
  }
  if (p === "/v1/admin/killswitch") {
    cp.killswitch = b.on === true;
    saveCp();
    notifyGatewayStandby();
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
  if (p === "/v1/admin/apple/reconcile") {
    if (!appleServerAPI) return j(503, { error: "apple_server_api_not_configured" });
    const environment =
      b.environment === "Production" || b.environment === "Sandbox" ? b.environment : undefined;
    try {
      return j(200, await runAppleReconciliation(environment));
    } catch (error) {
      return j(502, {
        error: "apple_reconciliation_failed",
        status: error.status,
        retryable: error.retryable,
      });
    }
  }
  if (p === "/v1/admin/apple/test-notification") {
    if (!appleServerAPI) return j(503, { error: "apple_server_api_not_configured" });
    if (b.environment !== "Production" && b.environment !== "Sandbox") {
      return j(400, { error: "invalid_apple_environment" });
    }
    try {
      const result = await appleServerAPI.requestTestNotification(b.environment);
      audit("apple.test_notification_requested", {
        environment: b.environment,
        testNotificationToken: result.testNotificationToken,
      });
      return j(200, result);
    } catch (error) {
      audit("apple.test_notification_request_failed", {
        environment: b.environment,
        status: error.status,
        reason: error.message || String(error),
      });
      return j(502, {
        error: "apple_test_notification_failed",
        status: error.status,
        retryable: error.retryable,
      });
    }
  }
  if (p === "/v1/admin/apple/test-notification-status") {
    if (!appleServerAPI) return j(503, { error: "apple_server_api_not_configured" });
    if (b.environment !== "Production" && b.environment !== "Sandbox") {
      return j(400, { error: "invalid_apple_environment" });
    }
    if (typeof b.testNotificationToken !== "string" || !b.testNotificationToken) {
      return j(400, { error: "test_notification_token_required" });
    }
    try {
      return j(
        200,
        await appleServerAPI.getTestNotificationStatus(
          b.environment,
          b.testNotificationToken,
        ),
      );
    } catch (error) {
      return j(502, {
        error: "apple_test_notification_status_failed",
        status: error.status,
        retryable: error.retryable,
      });
    }
  }

  // ————— public /v1 (contract §2) —————

  // Default-always-on gateway standby. This is deliberately NOT a remote command channel: the
  // only server-controlled value is the authoritative set of entitled subdomains. The request is
  // held for up to 25s and grant changes wake it immediately. `publicKeyPin` is durable trust
  // material returned to a genuinely paired app during remote first activation.
  if (p === "/v1/gateway/standby") {
    const gk = typeof b.gatewayKey === "string" ? b.gatewayKey.trim().toLowerCase() : "";
    const sub = bareSubdomain(b.subdomain);
    const publicKeyPin =
      typeof b.publicKeyPin === "string" ? b.publicKeyPin.trim().toLowerCase() : "";
    if (!/^[a-f0-9]{64}$/.test(gk) || !registry[gk]) {
      return j(403, { error: "gateway_not_allocated" });
    }
    if (!sub || registry[gk] !== sub) {
      return j(403, { error: "gateway_identity_mismatch" });
    }
    if (!/^[a-f0-9]{64}$/.test(publicKeyPin)) {
      return j(400, { error: "bad_public_key_pin" });
    }
    const previous = cp.gateways[gk];
    if (previous?.subdomain !== sub || previous?.publicKeyPin !== publicKeyPin) {
      cp.gateways[gk] = {
        subdomain: sub,
        publicKeyPin,
        registeredAt: previous?.registeredAt || now(),
        updatedAt: now(),
      };
      saveCp();
      audit("gateway.standby_registered", { gatewayKey: gk.slice(0, 12), subdomain: sub });
    }

    let active = desiredSubdomainsForGateway(gk, true);
    let revision = gatewayDesiredRevision(gk, active);
    const requestedRevision = typeof b.revision === "string" ? b.revision : "";
    const waitSec = Math.max(0, Math.min(25, Number(b.waitSec) || 0));
    if (requestedRevision && requestedRevision === revision && waitSec > 0) {
      await waitForGatewayDesiredChange(gk, waitSec * 1000);
      active = desiredSubdomainsForGateway(gk, true);
      revision = gatewayDesiredRevision(gk, active);
    }
    return j(200, {
      state: active.length ? "active" : "standby",
      subdomains: active,
      subDomainHost: SUBDOMAIN_HOST,
      revision,
    });
  }

  // Backward-compatible immediate reconcile endpoint for older plugins.
  if (p === "/v1/gateway/subdomains") {
    const gk = typeof b.gatewayKey === "string" ? b.gatewayKey.trim().toLowerCase() : "";
    if (!gk || !registry[gk]) return j(403, { error: "gateway_not_allocated" });
    const active = desiredSubdomainsForGateway(gk);
    return j(200, {
      subdomains: active,
      subDomainHost: SUBDOMAIN_HOST,
      revision: gatewayDesiredRevision(gk, active),
    });
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

    ensureBootstrapEntitlement(appAccountToken);
    if (!entitled(appAccountToken)) {
      return j(402, { error: "no_entitlement", hint: "需有效订阅" });
    }

    // The `subdomain` the app sends is the gateway's BASE subdomain (from the QR / durable
    // pairing) — the ownership TARGET. Under D31 the tunnel it actually activates is the
    // caller's PER-APPLE-ID subdomain (the base for the first owner, a distinct one after),
    // resolved below. Production never invents base subdomains the gate wouldn't trust.
    const gk = typeof b.gatewayKey === "string" ? b.gatewayKey.trim().toLowerCase() : "";
    // Emergency activation for a long-term LAN-only user: the app has the paired bearer and can
    // derive gatewayKey, but has never learned a public subdomain. The standby registration lets
    // the control plane resolve it without requiring the app to be home or re-scan anything.
    const baseSub = bareSubdomain(b.subdomain) || (gk ? registry[gk] : "");
    if (!baseSub && !gk)
      return j(400, { error: "subdomain_required", hint: "send subdomain or gatewayKey" });
    if (!baseSub)
      return j(400, {
        error: "gateway_standby_not_found",
        hint: "gateway has not registered FridayTunnel standby yet",
      });
    if (!used.has(baseSub)) return j(404, { error: "subdomain_not_allocated" });

    const owned = Object.entries(cp.tunnels).filter(
      ([, t]) => t.appAccountToken === appAccountToken,
    );
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
    const resolveKey =
      gk ||
      Object.keys(cp.appleSubs)
        .find((k) => k.endsWith(`:${appAccountToken}`))
        ?.split(":")[0];
    if (!resolveKey) {
      return j(403, { error: "subdomain_ownership_required", hint: "send gatewayKey" });
    }
    const sub = resolveAppleSubdomain(resolveKey, appAccountToken, baseSub);
    if (cp.revoked.includes(sub)) return j(403, { error: "subdomain_revoked" });

    let tunnelId = (owned.find(([, t]) => t.subdomain === sub) || [])[0];
    if (!tunnelId) {
      if (owned.length >= TUNNEL_CAP)
        return j(409, { error: "tunnel_cap_reached", cap: TUNNEL_CAP });
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
    const grantTtlSec = Math.max(
      0,
      Math.ceil((cp.grants[grantId].expiresAt - now()) / 1000),
    );
    audit("activate", { appAccountToken, subdomain: sub, grantId, attest: att.reason });
    return j(200, {
      tunnelId,
      subdomain: sub,
      node: cp.tunnels[tunnelId].node,
      publicUrl: `https://${sub}.${SUBDOMAIN_HOST}`,
      publicKeyPin: cp.gateways[resolveKey]?.publicKeyPin,
      grantId,
      grantTtlSec,
    });
  }

  // D16 grant sliding renewal. The grant may not outlive the subscription it rides on
  // (+72h grace, D-series 宽限) — an unconditional now+30d let a user renew on the eve
  // of expiry and keep the tunnel a whole month past their subscription.
  if (p === "/v1/grants/renew") {
    const g = cp.grants[b.grantId];
    if (!g) return j(404, { error: "grant_not_found" });
    if (!entitled(g.appAccountToken)) return j(402, { error: "no_entitlement" });
    if (ATTEST_REQUIRE && !g.attested) {
      // Grants issued before the attest wall went up don't get to slide past it.
      audit("renew.attest_rejected", { grantId: b.grantId });
      return j(403, { error: "attest_rejected", hint: "re-activate with attestation" });
    }
    const s = cp.subs[g.appAccountToken];
    const subCeiling = grantEntitlementCeiling(s);
    g.expiresAt = Math.min(now() + 30 * DAY, subCeiling);
    saveCp();
    audit("renew", { grantId: b.grantId });
    return j(200, { grantId: b.grantId, expiresAt: g.expiresAt });
  }

  // D8 subscription state (anonymous — appAccountToken only)
  if (p === "/v1/subscriptions/verify") {
    return j(200, subscriptionResponse(b.appAccountToken));
  }

  // StoreKit 2 client sync. StoreKit verifies locally for UX; THIS verification is the authority
  // that turns a purchase into a server entitlement. Normal purchases carry appAccountToken in
  // Apple's signed payload. Offer Code redemptions may omit it, so the first genuine-app sync
  // binds the signed originalTransactionId once; later syncs and ASSN notifications cannot move it.
  if (p === "/v1/apple/transactions/verify") {
    if (!appleTrustedRoots.length) return j(503, { error: "apple_verifier_not_configured" });
    try {
      const payload = verifyTransactionJWS(b.signedTransaction);
      const ownership = resolveAppleTransactionOwner(payload, b.appAccountToken);
      const attestation = await verifyAppleClientAttest(b, payload);
      if (attestation.invalid) throw new Error(`attest_${attestation.reason}`);
      if (ownership.firstBind && ATTEST_REQUIRE && !attestation.verified) {
        const error = new Error(
          attestation.reason === "unknown_key"
            ? "attest_unknown_key"
            : "attest_required_for_offer_code_bind",
        );
        error.controlPlaneHint =
          attestation.reason === "unknown_key" ? "unknown_key" : attestation.reason;
        throw error;
      }
      const applied = applyAppleTransaction(
        payload,
        "CLIENT_SYNC",
        ownership.appAccountToken,
      );
      if (ownership.firstBind) {
        audit("apple.offer_code_bound", {
          appAccountToken: ownership.appAccountToken,
          originalTransactionId: applied.originalTransactionId,
          attested: attestation.verified,
          source: ownership.source,
        });
      }
      return j(200, subscriptionResponse(applied.appAccountToken));
    } catch (error) {
      audit("apple.transaction_rejected", { reason: error.message || String(error) });
      if (error.message === "attest_unknown_key") {
        return j(403, { error: "attest_rejected", hint: "unknown_key" });
      }
      if (String(error.message || "").startsWith("attest_")) {
        return j(403, { error: "attest_rejected" });
      }
      return j(403, { error: "apple_transaction_rejected" });
    }
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
      if (size > OSS_MAX_OBJECT_BYTES)
        return j(413, { error: "object_too_large", maxBytes: OSS_MAX_OBJECT_BYTES });
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

  // App Store Server Notifications v2. This endpoint is intentionally public: authenticity comes
  // from Apple's outer signedPayload AND the nested signedTransactionInfo, never a shared bearer.
  // Apple retries notifications, so `applyAppleTransaction` is signedDate-idempotent.
  if (p === "/v1/apple/webhook") {
    if (!appleTrustedRoots.length) return j(503, { error: "apple_verifier_not_configured" });
    try {
      return j(200, await processAppleSignedNotification(b.signedPayload, "webhook"));
    } catch (error) {
      audit("apple.notification_rejected", { reason: error.message || String(error) });
      return j(
        error?.name === "AppleServerAPIError" ? 502 : 403,
        { error: "apple_notification_rejected" },
      );
    }
  }

  return j(404, { error: "not_found" });
});
cpServer.listen(CP_PORT, HOST, () =>
  console.log(
    `gw-alloc (control-plane) on ${HOST}:${CP_PORT} bootstrap=${BOOTSTRAP_ENABLED} bootstrapTtlSec=${BOOTSTRAP_TTL_MS / 1000} attestRequire=${ATTEST_REQUIRE} enforceGrants=${ENFORCE_GRANTS}`,
  ),
);

if (appleServerAPI && APPLE_RECONCILE_INTERVAL_MS) {
  const runScheduledAppleReconciliation = () => {
    runAppleReconciliation().catch((error) => {
      console.error(`[cp] App Store reconciliation failed: ${error.message}`);
    });
  };
  const initialReconcile = setTimeout(
    runScheduledAppleReconciliation,
    Math.min(15_000, APPLE_RECONCILE_INTERVAL_MS),
  );
  initialReconcile.unref?.();
  const reconcileTimer = setInterval(
    runScheduledAppleReconciliation,
    APPLE_RECONCILE_INTERVAL_MS,
  );
  reconcileTimer.unref?.();
}
