"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const APPLE_APP_STORE_JWS_OID = Buffer.from("060a2a864886f76364060b01", "hex");

function base64urlDecode(value) {
  return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function decodeJSON(segment, label) {
  try {
    return JSON.parse(base64urlDecode(segment).toString("utf8"));
  } catch {
    throw new Error(`invalid_${label}`);
  }
}

function certificate(value) {
  return value instanceof crypto.X509Certificate ? value : new crypto.X509Certificate(value);
}

/** Load one or more Apple trust anchors from colon-separated PEM/DER file paths. */
function loadTrustedRoots(pathsValue) {
  if (!pathsValue) return [];
  return String(pathsValue)
    .split(":")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => certificate(fs.readFileSync(p)));
}

function validAt(cert, timestamp) {
  const date = Number(timestamp);
  return date >= Date.parse(cert.validFrom) && date <= Date.parse(cert.validTo);
}

function verifyChain(chain, roots, timestamp) {
  if (!chain.length) throw new Error("missing_x5c");
  if (!roots.length) throw new Error("apple_roots_not_configured");
  for (const cert of chain) {
    if (!validAt(cert, timestamp)) throw new Error("certificate_not_valid_at_signed_date");
  }
  for (let i = 0; i < chain.length - 1; i++) {
    if (!chain[i].verify(chain[i + 1].publicKey)) throw new Error("invalid_certificate_chain");
  }
  const tail = chain[chain.length - 1];
  const anchored = roots.some((root) => {
    if (tail.fingerprint256 === root.fingerprint256) return true;
    return validAt(root, timestamp) && tail.verify(root.publicKey);
  });
  if (!anchored) throw new Error("untrusted_certificate_chain");
}

/**
 * Verify and decode an Apple ES256 compact JWS. Trust is anchored exclusively in the Apple root
 * certificates provisioned by the operator; the caller then pins bundle/product/account fields.
 * `requireAppleExtension` is disabled only by the generated local test fixture.
 */
function verifyAppleJWS(jws, options) {
  const parts = String(jws || "").split(".");
  if (parts.length !== 3) throw new Error("invalid_jws");
  const header = decodeJSON(parts[0], "header");
  const payload = decodeJSON(parts[1], "payload");
  if (header.alg !== "ES256") throw new Error("unsupported_alg");
  if (!Array.isArray(header.x5c) || !header.x5c.length) throw new Error("missing_x5c");
  const chain = header.x5c.map((der) => certificate(Buffer.from(der, "base64")));
  const signedAt = Number(payload.signedDate || options.now || Date.now());
  if (!Number.isFinite(signedAt)) throw new Error("invalid_signed_date");
  verifyChain(chain, options.trustedRoots || [], signedAt);
  if (options.requireAppleExtension !== false && !chain[0].raw.includes(APPLE_APP_STORE_JWS_OID)) {
    throw new Error("wrong_leaf_certificate_purpose");
  }
  const signature = base64urlDecode(parts[2]);
  if (signature.length !== 64) throw new Error("invalid_signature_shape");
  const ok = crypto.verify(
    "sha256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key: chain[0].publicKey, dsaEncoding: "ieee-p1363" },
    signature,
  );
  if (!ok) throw new Error("invalid_signature");
  if (options.bundleId && payload.bundleId !== options.bundleId) throw new Error("bundle_mismatch");
  if (options.productId && payload.productId !== options.productId) throw new Error("product_mismatch");
  if (
    options.appAccountToken &&
    String(payload.appAccountToken || "").toLowerCase() !== String(options.appAccountToken).toLowerCase()
  ) {
    throw new Error("app_account_token_mismatch");
  }
  return payload;
}

module.exports = { loadTrustedRoots, verifyAppleJWS };
