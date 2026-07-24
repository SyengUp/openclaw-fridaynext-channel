#!/usr/bin/env node
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import appleJWS from "./apple-jws.js";

const { verifyAppleJWS } = appleJWS;
const dir = mkdtempSync(join(tmpdir(), "apple-jws-test-"));
let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}: ${error.message}`);
  }
}
function expectThrow(name, fn, expected) {
  check(name, () => {
    try {
      fn();
    } catch (error) {
      if (error.message === expected) return;
      throw error;
    }
    throw new Error(`expected ${expected}`);
  });
}
function b64url(data) {
  return Buffer.from(data).toString("base64url");
}

try {
  const rootKey = join(dir, "root.key");
  const rootPem = join(dir, "root.pem");
  const leafKey = join(dir, "leaf.key");
  const leafCSR = join(dir, "leaf.csr");
  const leafPem = join(dir, "leaf.pem");
  const leafDer = join(dir, "leaf.der");
  const ext = join(dir, "leaf.ext");
  execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", rootKey]);
  execFileSync("openssl", ["req", "-x509", "-new", "-key", rootKey, "-subj", "/CN=Test Root", "-days", "30", "-out", rootPem]);
  execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", leafKey]);
  execFileSync("openssl", ["req", "-new", "-key", leafKey, "-subj", "/CN=Test App Store", "-out", leafCSR]);
  writeFileSync(ext, "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n1.2.840.113635.100.6.11.1=DER:05:00\n");
  execFileSync("openssl", ["x509", "-req", "-in", leafCSR, "-CA", rootPem, "-CAkey", rootKey, "-CAcreateserial", "-days", "30", "-extfile", ext, "-out", leafPem]);
  execFileSync("openssl", ["x509", "-in", leafPem, "-outform", "DER", "-out", leafDer]);

  const root = new crypto.X509Certificate(readFileSync(rootPem));
  const header = { alg: "ES256", x5c: [readFileSync(leafDer).toString("base64")] };
  const payload = {
    bundleId: "SyengUp.FridayNext",
    productId: "SyengUp.FridayNext.Tunnel.yearly",
    appAccountToken: "00000000-0000-0000-0000-000000000001",
    transactionId: "42",
    originalTransactionId: "41",
    expiresDate: Date.now() + 86_400_000,
    signedDate: Date.now(),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign(
    "sha256",
    Buffer.from(signingInput),
    { key: readFileSync(leafKey), dsaEncoding: "ieee-p1363" },
  );
  const jws = `${signingInput}.${b64url(signature)}`;
  const options = {
    trustedRoots: [root],
    bundleId: payload.bundleId,
    productId: payload.productId,
    appAccountToken: payload.appAccountToken,
  };

  check("valid Apple-shaped ES256 JWS", () => {
    const decoded = verifyAppleJWS(jws, options);
    if (decoded.transactionId !== "42") throw new Error("payload mismatch");
  });
  expectThrow(
    "product pin rejects another IAP",
    () => verifyAppleJWS(jws, { ...options, productId: "evil.product" }),
    "product_mismatch",
  );
  expectThrow(
    "appAccountToken pin rejects another account",
    () => verifyAppleJWS(jws, { ...options, appAccountToken: crypto.randomUUID() }),
    "app_account_token_mismatch",
  );
  const tampered = `${parts(jws)[0]}.${b64url(JSON.stringify({ ...payload, expiresDate: 0 }))}.${parts(jws)[2]}`;
  expectThrow("payload tampering breaks signature", () => verifyAppleJWS(tampered, options), "invalid_signature");
  expectThrow(
    "untrusted root is fail-closed",
    () => verifyAppleJWS(jws, { ...options, trustedRoots: [] }),
    "apple_roots_not_configured",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function parts(jws) {
  return jws.split(".");
}

console.log(`\n${failed ? "❌" : "✅"} passed=${passed} failed=${failed}`);
if (failed) process.exit(1);
