/**
 * App Attest endpoints — "only the genuine FridayNext app can connect".
 *
 *  GET  /friday-next/attest/challenge  → { challenge }        one-time nonce
 *  POST /friday-next/attest/verify     { keyId, attestation, challenge } → { sessionToken, exp }
 *  POST /friday-next/attest/refresh    { keyId, assertion, challenge }   → { sessionToken, exp }
 *
 * verify runs Apple's full attestation check (root CA, nonce, appId, key match)
 * on first use and stores the attested public key; refresh proves continued
 * possession of that key with a signed assertion. Both mint a stateless HMAC
 * session token the app then sends on every request. All Bearer-authed (the app
 * already holds the gateway token).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyAttestation, verifyAssertion } from "node-app-attest";
import { extractBearerToken } from "../middleware/auth.js";
import { resolveFridayNextConfig } from "../../config.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { getFridayNextRuntime } from "../../runtime.js";
import { createFridayNextLogger } from "../../logging.js";
import {
  consumeChallenge,
  getKey,
  issueChallenge,
  issueSession,
  saveKey,
  updateSignCount,
} from "../../attest/attest-store.js";

function config() {
  return resolveFridayNextConfig(getHostOpenClawConfigSnapshot(getFridayNextRuntime().config));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 65_536) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function json(res: ServerResponse, code: number, obj: unknown): boolean {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
  return true;
}

function authed(req: IncomingMessage, res: ServerResponse): boolean {
  if (extractBearerToken(req)) return true;
  json(res, 401, { error: "Unauthorized: bearer token mismatch" });
  return false;
}

export function handleAttestChallenge(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "GET") return json(res, 405, { error: "Method Not Allowed" });
  if (!authed(req, res)) return true;
  return json(res, 200, { challenge: issueChallenge(Date.now()) });
}

export async function handleAttestVerify(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });
  if (!authed(req, res)) return true;
  const cfg = config();
  const body = await readJson(req);
  const keyId = typeof body?.keyId === "string" ? body.keyId : "";
  const attestationB64 = typeof body?.attestation === "string" ? body.attestation : "";
  const challenge = typeof body?.challenge === "string" ? body.challenge : "";
  if (!keyId || !attestationB64 || !challenge) {
    return json(res, 400, { error: "keyId, attestation, challenge required" });
  }
  if (!consumeChallenge(challenge, Date.now())) {
    return json(res, 400, { error: "invalid or expired challenge" });
  }
  try {
    const result = verifyAttestation({
      attestation: Buffer.from(attestationB64, "base64"),
      challenge,
      keyId,
      bundleIdentifier: cfg.appAttest.bundleId,
      teamIdentifier: cfg.appAttest.teamId,
      allowDevelopmentEnvironment: cfg.appAttest.allowDevelopment,
    });
    saveKey(keyId, { publicKey: result.publicKey, signCount: 0, environment: result.environment });
    const { token, exp } = issueSession(keyId, cfg.authToken, Date.now());
    return json(res, 200, { sessionToken: token, exp });
  } catch (e) {
    createFridayNextLogger("attest").warn(
      `attestation rejected: ${e instanceof Error ? e.message : String(e)}`,
    );
    return json(res, 403, { error: "attestation rejected" });
  }
}

export async function handleAttestRefresh(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });
  if (!authed(req, res)) return true;
  const cfg = config();
  const body = await readJson(req);
  const keyId = typeof body?.keyId === "string" ? body.keyId : "";
  const assertionB64 = typeof body?.assertion === "string" ? body.assertion : "";
  const challenge = typeof body?.challenge === "string" ? body.challenge : "";
  if (!keyId || !assertionB64 || !challenge) {
    return json(res, 400, { error: "keyId, assertion, challenge required" });
  }
  const stored = getKey(keyId);
  if (!stored) return json(res, 403, { error: "unknown key — attest first" });
  if (!consumeChallenge(challenge, Date.now())) {
    return json(res, 400, { error: "invalid or expired challenge" });
  }
  try {
    const { signCount } = verifyAssertion({
      assertion: Buffer.from(assertionB64, "base64"),
      payload: challenge,
      publicKey: stored.publicKey,
      bundleIdentifier: cfg.appAttest.bundleId,
      teamIdentifier: cfg.appAttest.teamId,
      signCount: stored.signCount,
    });
    updateSignCount(keyId, signCount);
    const { token, exp } = issueSession(keyId, cfg.authToken, Date.now());
    return json(res, 200, { sessionToken: token, exp });
  } catch (e) {
    createFridayNextLogger("attest").warn(
      `assertion rejected: ${e instanceof Error ? e.message : String(e)}`,
    );
    return json(res, 403, { error: "assertion rejected" });
  }
}
