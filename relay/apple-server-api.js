"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const DEFAULT_BASE_URLS = Object.freeze({
  Production: "https://api.storekit.apple.com",
  Sandbox: "https://api.storekit-sandbox.apple.com",
});

function base64urlJSON(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function normalizeEnvironment(environment) {
  if (environment === "Production" || environment === "Sandbox") return environment;
  throw new Error("invalid_apple_environment");
}

class AppleServerAPIError extends Error {
  constructor(message, { status, body, retryable = false } = {}) {
    super(message);
    this.name = "AppleServerAPIError";
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

class AppleServerAPIClient {
  constructor({
    issuerId,
    keyId,
    bundleId,
    privateKey,
    fetchImpl = globalThis.fetch,
    baseURLs = DEFAULT_BASE_URLS,
    timeoutMs = 15_000,
    now = () => Date.now(),
  }) {
    if (!issuerId || !keyId || !bundleId || !privateKey) {
      throw new Error("apple_server_api_credentials_incomplete");
    }
    if (typeof fetchImpl !== "function") throw new Error("fetch_unavailable");
    this.issuerId = issuerId;
    this.keyId = keyId;
    this.bundleId = bundleId;
    this.privateKey =
      privateKey instanceof crypto.KeyObject ? privateKey : crypto.createPrivateKey(privateKey);
    this.fetchImpl = fetchImpl;
    this.baseURLs = { ...DEFAULT_BASE_URLS, ...baseURLs };
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  static fromEnv(env = process.env, options = {}) {
    const issuerId = String(env.APPLE_SERVER_API_ISSUER_ID || "").trim();
    const keyId = String(env.APPLE_SERVER_API_KEY_ID || "").trim();
    const privateKeyFile = String(env.APPLE_SERVER_API_PRIVATE_KEY_FILE || "").trim();
    if (!issuerId && !keyId && !privateKeyFile) return null;
    if (!issuerId || !keyId || !privateKeyFile) {
      throw new Error("apple_server_api_credentials_incomplete");
    }
    const privateKey = fs.readFileSync(privateKeyFile);
    return new AppleServerAPIClient({
      issuerId,
      keyId,
      bundleId: String(env.CP_ATTEST_BUNDLE_ID || "SyengUp.FridayNext"),
      privateKey,
      baseURLs: {
        Production:
          String(env.APPLE_SERVER_API_PRODUCTION_URL || "").trim() ||
          DEFAULT_BASE_URLS.Production,
        Sandbox:
          String(env.APPLE_SERVER_API_SANDBOX_URL || "").trim() || DEFAULT_BASE_URLS.Sandbox,
      },
      ...options,
    });
  }

  createAuthorizationToken() {
    const issuedAt = Math.floor(this.now() / 1000);
    // Apple permits up to 60 minutes for App Store Server API tokens. Five minutes limits
    // credential exposure while leaving enough headroom for clock skew and paginated calls.
    const header = { alg: "ES256", kid: this.keyId, typ: "JWT" };
    const payload = {
      iss: this.issuerId,
      iat: issuedAt,
      exp: issuedAt + 5 * 60,
      aud: "appstoreconnect-v1",
      bid: this.bundleId,
    };
    const input = `${base64urlJSON(header)}.${base64urlJSON(payload)}`;
    const signature = crypto.sign("sha256", Buffer.from(input), {
      key: this.privateKey,
      dsaEncoding: "ieee-p1363",
    });
    return `${input}.${signature.toString("base64url")}`;
  }

  async request(environment, pathname, { method = "GET", body } = {}) {
    const normalizedEnvironment = normalizeEnvironment(environment);
    const baseURL = this.baseURLs[normalizedEnvironment];
    const url = new URL(pathname, baseURL);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.createAuthorizationToken()}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new AppleServerAPIError(
        error?.name === "AbortError" ? "apple_server_api_timeout" : "apple_server_api_unreachable",
        { retryable: true },
      );
    } finally {
      clearTimeout(timeout);
    }

    const raw = await response.text();
    let decoded = {};
    if (raw) {
      try {
        decoded = JSON.parse(raw);
      } catch {
        throw new AppleServerAPIError("apple_server_api_invalid_json", {
          status: response.status,
          retryable: response.status >= 500,
        });
      }
    }
    if (!response.ok) {
      throw new AppleServerAPIError(`apple_server_api_http_${response.status}`, {
        status: response.status,
        body: decoded,
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    return decoded;
  }

  getNotificationHistory(environment, body, paginationToken) {
    const query = paginationToken
      ? `?paginationToken=${encodeURIComponent(paginationToken)}`
      : "";
    return this.request(environment, `/inApps/v1/notifications/history${query}`, {
      method: "POST",
      body,
    });
  }

  getAllSubscriptionStatuses(environment, transactionId) {
    return this.request(
      environment,
      `/inApps/v1/subscriptions/${encodeURIComponent(transactionId)}`,
    );
  }

  sendConsumptionInformation(environment, transactionId, consumption) {
    return this.request(
      environment,
      `/inApps/v2/transactions/consumption/${encodeURIComponent(transactionId)}`,
      { method: "PUT", body: consumption },
    );
  }

  requestTestNotification(environment) {
    return this.request(environment, "/inApps/v1/notifications/test", { method: "POST" });
  }

  getTestNotificationStatus(environment, testNotificationToken) {
    return this.request(
      environment,
      `/inApps/v1/notifications/test/${encodeURIComponent(testNotificationToken)}`,
    );
  }
}

module.exports = {
  AppleServerAPIClient,
  AppleServerAPIError,
  DEFAULT_BASE_URLS,
};
