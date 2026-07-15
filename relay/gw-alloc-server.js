#!/usr/bin/env node
/**
 * FridayNext relay service — subdomain allocation + ACME cert signing + tunnel gate.
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
 * Single Node process; registry written atomically. 7001 is bound to 127.0.0.1 and
 * exposed via nginx at https://friday.syengup.host/gw-alloc/ (prefix stripped); 7002
 * is bound to 127.0.0.1 and is reachable ONLY by the local frps.
 */
const http = require("node:http");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileP = promisify(execFile);

const PORT = 7001;
const FRP_GATE_PORT = 7002; // frps httpPlugin NewProxy callback; localhost-only
const HOST = "127.0.0.1";
const DATA = "/opt/gw-alloc/registry.json";
const TMP = "/opt/gw-alloc/tmp";
const WEBROOT = "/var/www/acme";
const SUBDOMAIN_HOST = "bj.gw.syengup.host";
const ACME_EMAIL = "admin@syengup.host";
// Bearer secret for /allocate + /sign-cert. Sourced from the environment ONLY —
// never hardcoded, because this value is also the frps auth.token, which is shared
// with the operator's personal tunnels. Keeping it out of the (open-source) repo is
// what lets the relay be published without leaking the token. Set via systemd
// `Environment=GW_ALLOC_TOKEN=…`.
const TOKEN = process.env.GW_ALLOC_TOKEN;
if (!TOKEN) {
  console.error("FATAL: GW_ALLOC_TOKEN not set — refusing to start without a bearer secret");
  process.exit(1);
}
// Per-tunnel server-enforced bandwidth cap. Generous for a personal gateway
// (chat + attachments + canvas), but stops one tunnel saturating the relay.
const BW_LIMIT = process.env.GW_TUNNEL_BW || "4MB";

fs.mkdirSync(TMP, { recursive: true });

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA, "utf8"));
  } catch {
    return {};
  }
}
function save(reg) {
  const tmp = DATA + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, DATA); // atomic replace
}

const registry = load(); // { keyHash: subdomain }
const used = new Set(Object.values(registry));

function allocate(key) {
  if (registry[key]) return registry[key]; // idempotent
  let sub;
  do {
    sub = "fn" + crypto.randomBytes(5).toString("hex");
  } while (used.has(sub)); // registry-checked uniqueness = hard guarantee
  registry[key] = sub;
  used.add(sub);
  save(registry);
  return sub;
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
        .then((fullchain) => j(200, { fullchain, fqdn: `${subdomain}.${SUBDOMAIN_HOST}` }))
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

    // It claims our namespace → it MUST correspond to an allocated subdomain.
    const okSub = allocatedSubdomain(sub);
    const okDomain = domains.some((d) => allocatedSubdomain(String(d).split(".")[0]));

    if (!okSub && !okDomain) {
      const asked = sub || domains.join(",") || "(none)";
      console.log(`[frp-gate] REJECT proxy=${content.proxy_name} sub=${asked} — not allocated`);
      return reply({ reject: true, reject_reason: "subdomain not allocated by relay" });
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
