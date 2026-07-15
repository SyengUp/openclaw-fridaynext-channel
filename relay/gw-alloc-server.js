#!/usr/bin/env node
/**
 * FridayNext gateway subdomain allocator — the single authority that makes public
 * subdomains collision-proof by construction. Each gateway sends a stable identity
 * hash (`key`); the allocator returns a unique subdomain, idempotently (same key →
 * same subdomain forever, distinct keys → distinct subdomains, never a duplicate).
 *
 * Single Node process + one JSON registry written atomically (temp + rename) — so
 * check-and-assign is race-free. Bound to 127.0.0.1; exposed via nginx at
 * https://friday.syengup.host/gw-alloc/ (prefix stripped by proxy_pass).
 */
const http = require("node:http");
const fs = require("node:fs");
const crypto = require("node:crypto");

const PORT = 7001;
const HOST = "127.0.0.1";
const DATA = "/opt/gw-alloc/registry.json";
const TOKEN = process.env.GW_ALLOC_TOKEN || "3bWAWKlikrYq2aoD4tAocC2HyQA6ar";

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
  if (registry[key]) return registry[key]; // idempotent: same gateway, same subdomain
  let sub;
  do {
    sub = "fn" + crypto.randomBytes(5).toString("hex");
  } while (used.has(sub)); // registry-checked uniqueness = hard guarantee
  registry[key] = sub;
  used.add(sub);
  save(registry);
  return sub;
}

const server = http.createServer((req, res) => {
  const j = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.method !== "POST" || req.url !== "/allocate") return j(404, { error: "not found" });

  const auth = req.headers.authorization || "";
  const tok = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (tok !== TOKEN) return j(401, { error: "unauthorized" });

  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 4096) req.destroy();
  });
  req.on("end", () => {
    let key;
    try {
      key = JSON.parse(body).key;
    } catch {
      key = null;
    }
    if (typeof key !== "string" || !/^[a-f0-9]{16,128}$/i.test(key)) {
      return j(400, { error: "bad key (expect hex hash 16-128 chars)" });
    }
    const subdomain = allocate(key.toLowerCase());
    j(200, { subdomain });
  });
});
server.listen(PORT, HOST, () => console.log(`gw-alloc listening on ${HOST}:${PORT}`));
