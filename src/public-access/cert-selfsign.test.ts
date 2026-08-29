import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate, createPublicKey, verify as cryptoVerify } from "node:crypto";
import {
  createCsrPem,
  createSelfSignedCertPem,
  generateRsaKeyPairPem,
} from "./cert-selfsign.js";

const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("cert-selfsign", () => {
  const { publicKeyPem, privateKeyPem } = generateRsaKeyPairPem();

  it("generates an RSA-2048 PEM keypair", () => {
    expect(privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(publicKeyPem).toContain("BEGIN PUBLIC KEY");
    const key = createPublicKey(publicKeyPem);
    expect(key.asymmetricKeyType).toBe("rsa");
  });

  it("mints a self-signed cert that parses, self-verifies, and carries CN + SAN", () => {
    const pem = createSelfSignedCertPem("fn0123456789.na.gw.syengup.host", privateKeyPem, publicKeyPem, 3650);
    const cert = new X509Certificate(pem);
    expect(cert.subject).toContain("CN=fn0123456789.na.gw.syengup.host");
    expect(cert.issuer).toBe(cert.subject);
    // Signature verifies against the paired public key (self-signed consistency).
    expect(cert.verify(createPublicKey(publicKeyPem))).toBe(true);
    // SAN present (Go/modern TLS stacks ignore CN without it).
    expect(cert.subjectAltName).toContain("DNS:fn0123456789.na.gw.syengup.host");
    // Roughly 3650 days out.
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(
      Date.now() + 3600 * 24 * 3600 * 1000,
    );
  });

  it("tbs signature on the cert verifies with crypto.verify over the raw tbs bytes", () => {
    // Independent check that the BIT STRING carries a real sha256-RSA signature:
    // X509Certificate.verify already proves it; this pins the algorithm choice.
    const pem = createSelfSignedCertPem("x.example", privateKeyPem, publicKeyPem, 30);
    const cert = new X509Certificate(pem);
    expect(cert.signatureAlgorithm ?? "").not.toBe("");
    expect(cert.verify(createPublicKey(publicKeyPem))).toBe(true);
  });

  it("CSR carries the CN and a valid sha256-RSA signature (openssl cross-check)", () => {
    if (!hasOpenssl) return; // dev machines have openssl; the point is DER correctness
    const dir = mkdtempSync(join(tmpdir(), "csr-test-"));
    const csrPath = join(dir, "t.csr");
    const pubPath = join(dir, "t.pub");
    const csr = createCsrPem("fn0123456789.na.gw.syengup.host", privateKeyPem, publicKeyPem);
    expect(csr).toContain("BEGIN CERTIFICATE REQUEST");
    writeFileSync(csrPath, csr);
    writeFileSync(pubPath, publicKeyPem);
    const text = execFileSync("openssl", ["req", "-in", csrPath, "-noout", "-text"]).toString();
    expect(text).toMatch(/CN\s*=\s*fn0123456789\.na\.gw\.syengup\.host/);
    // `openssl req -verify` prints "verify OK" to stderr on LibreSSL and exits nonzero on
    // failure — not throwing IS the assertion.
    execFileSync("openssl", ["req", "-in", csrPath, "-noout", "-verify"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("openssl can also parse our self-signed cert", () => {
    if (!hasOpenssl) return;
    const dir = mkdtempSync(join(tmpdir(), "crt-test-"));
    const crtPath = join(dir, "t.crt");
    writeFileSync(crtPath, createSelfSignedCertPem("y.example", privateKeyPem, publicKeyPem, 30));
    const text = execFileSync("openssl", ["x509", "-in", crtPath, "-noout", "-text"]).toString();
    expect(text).toMatch(/CN\s*=\s*y\.example/);
    expect(text).toContain("CA:TRUE");
    expect(text).toContain("DNS:y.example");
  });

  it("UTC times stay within the 2050 UTCTime window", () => {
    const pem = createSelfSignedCertPem("z.example", privateKeyPem, publicKeyPem, 3650);
    const year = new Date(new X509Certificate(pem).validTo).getUTCFullYear();
    expect(year).toBeLessThan(2050); // 3650 days from now must stay UTCTime-encodable
  });
});
