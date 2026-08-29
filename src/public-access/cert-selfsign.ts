/**
 * Self-contained X.509/PKCS#10 generation — replaces the openssl CLI so FridayTunnel works on
 * gateways without it (Windows has no openssl; Win10+ tar.exe remains the only external tool).
 *
 * Only what FridayTunnel needs: RSA-2048 keypair, a CN-only PKCS#10 CSR for the relay's
 * cert-signer, and a v3 self-signed server cert (BC CA:true + SAN) as the offline fallback.
 * The app pins the gateway's public KEY (PKCS#1 hash), so cert regeneration never breaks pins.
 */
import { generateKeyPairSync, sign as cryptoSign, createPublicKey, randomBytes } from "node:crypto";

// ——— minimal DER writer ———

function derLen(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let v = len;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const oid = (bytes: number[]): Buffer => tlv(0x06, Buffer.from(bytes));
const nullTag = (): Buffer => Buffer.from([0x05, 0x00]);
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, "utf8"));
const utcTime = (d: Date): Buffer => {
  const p = (n: number) => String(n).padStart(2, "0");
  const yy = String(d.getUTCFullYear() % 100).padStart(2, "0");
  return tlv(0x17, Buffer.from(`${yy}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
};
function integer(bytes: Buffer): Buffer {
  let b = bytes;
  while (b.length > 1 && b[0] === 0x00 && (b[1] & 0x80) === 0) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
  return tlv(0x02, b);
}
const bitString = (payload: Buffer): Buffer =>
  tlv(0x03, Buffer.concat([Buffer.from([0x00]), payload]));

// OID byte encodings (precomputed; standard arcs).
const OID_RSA_ENCRYPTION = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]; // 1.2.840.113549.1.1.1
const OID_SHA256_WITH_RSA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]; // 1.2.840.113549.1.1.11
const OID_COMMON_NAME = [0x55, 0x04, 0x03]; // 2.5.4.3
const OID_BASIC_CONSTRAINTS = [0x55, 0x1d, 0x13]; // 2.5.29.19
const OID_SUBJECT_ALT_NAME = [0x55, 0x1d, 0x11]; // 2.5.29.17

const ALGO_RSA = seq(oid(OID_RSA_ENCRYPTION), nullTag());
const ALGO_SHA256_RSA = seq(oid(OID_SHA256_WITH_RSA), nullTag());

const distinguishedName = (cn: string): Buffer => seq(set(seq(oid(OID_COMMON_NAME), utf8(cn))));

function pem(label: string, der: Buffer): string {
  const b64 = der.toString("base64").replace(/.{64}/g, "$&\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

function rsaPublicKeySpkiDer(publicKeyPem: string): Buffer {
  return createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
}

function signSha256Rsa(privateKeyPem: string, payload: Buffer): Buffer {
  return cryptoSign("sha256", payload, privateKeyPem);
}

/** Fresh RSA-2048 keypair as PEM (private: PKCS#8 "BEGIN PRIVATE KEY" — Go/frpc reads it). */
export function generateRsaKeyPairPem(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

/** PKCS#10 CSR for `cn`, signed sha256WithRSAEncryption. Only the relay's own signer reads
 * this (it extracts the CN), so an empty attribute set is sufficient. */
export function createCsrPem(cn: string, privateKeyPem: string, publicKeyPem: string): string {
  const cri = seq(
    integer(Buffer.from([0])), // version = v1
    distinguishedName(cn),
    rsaPublicKeySpkiDer(publicKeyPem),
    tlv(0xa0, Buffer.alloc(0)), // [0] attributes, empty
  );
  const csr = seq(cri, ALGO_SHA256_RSA, bitString(signSha256Rsa(privateKeyPem, cri)));
  return pem("CERTIFICATE REQUEST", csr);
}

/** v3 self-signed server cert for `cn` (BC critical CA:true + SAN dNSName=cn, mirrors what
 * openssl req -x509 emits), valid `days` from now. Fallback for when the LE signer is down;
 * the app pins the public key either way. */
export function createSelfSignedCertPem(
  cn: string,
  privateKeyPem: string,
  publicKeyPem: string,
  days = 3650,
): string {
  const name = distinguishedName(cn);
  const notBefore = new Date(Date.now() - 60_000); // clock-skew slack
  const notAfter = new Date(notBefore.getTime() + days * 86_400_000);
  const serial = integer(cryptoRandomPositive(16));
  const extensions = seq(
    // basicConstraints critical CA:TRUE
    seq(oid(OID_BASIC_CONSTRAINTS), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq(tlv(0x01, Buffer.from([0xff]))))),
    // subjectAltName dNSName=cn (dNSName = context [2] primitive IA5String → tag 0x82)
    seq(oid(OID_SUBJECT_ALT_NAME), tlv(0x04, seq(tlv(0x82, Buffer.from(cn, "ascii"))))),
  );
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))), // [0] EXPLICIT version = v3
    serial,
    ALGO_SHA256_RSA,
    name, // issuer = subject (self-signed)
    seq(utcTime(notBefore), utcTime(notAfter)),
    name,
    rsaPublicKeySpkiDer(publicKeyPem),
    tlv(0xa3, extensions), // [3] EXPLICIT extensions
  );
  const cert = seq(tbs, ALGO_SHA256_RSA, bitString(signSha256Rsa(privateKeyPem, tbs)));
  return pem("CERTIFICATE", cert);
}

function cryptoRandomPositive(bytes: number): Buffer {
  const b = randomBytes(bytes);
  b[0] &= 0x7f; // keep the INTEGER positive
  if (b[0] === 0) b[0] = 1;
  return b;
}
