#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { AppleServerAPIClient, AppleServerAPIError } = require("./apple-server-api.js");

const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const fixedNow = 1_720_000_000_000;
const calls = [];
const responses = [
  new Response(
    JSON.stringify({
      notificationHistory: [{ signedPayload: "outer.jws.value" }],
      hasMore: true,
      paginationToken: "next page",
    }),
    { status: 200 },
  ),
  new Response(
    JSON.stringify({
      bundleId: "SyengUp.FridayNext",
      environment: "Sandbox",
      data: [],
    }),
    { status: 200 },
  ),
  new Response(JSON.stringify({ testNotificationToken: "test-token" }), { status: 200 }),
  new Response(JSON.stringify({ sendAttempts: [] }), { status: 200 }),
  new Response(null, { status: 202 }),
];

const client = new AppleServerAPIClient({
  issuerId: "issuer-id",
  keyId: "KEY123",
  bundleId: "SyengUp.FridayNext",
  privateKey,
  now: () => fixedNow,
  baseURLs: {
    Production: "https://production.example.test",
    Sandbox: "https://sandbox.example.test",
  },
  fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return responses.shift();
  },
});

const token = client.createAuthorizationToken();
const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
assert.deepEqual(JSON.parse(Buffer.from(encodedHeader, "base64url")), {
  alg: "ES256",
  kid: "KEY123",
  typ: "JWT",
});
assert.deepEqual(JSON.parse(Buffer.from(encodedPayload, "base64url")), {
  iss: "issuer-id",
  iat: fixedNow / 1000,
  exp: fixedNow / 1000 + 300,
  aud: "appstoreconnect-v1",
  bid: "SyengUp.FridayNext",
});
assert.equal(
  crypto.verify(
    "sha256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(encodedSignature, "base64url"),
  ),
  true,
);

const history = await client.getNotificationHistory(
  "Sandbox",
  { startDate: 1, endDate: 2, onlyFailures: false },
  "next page",
);
assert.equal(history.hasMore, true);
assert.equal(
  calls[0].url,
  "https://sandbox.example.test/inApps/v1/notifications/history?paginationToken=next%20page",
);
assert.equal(calls[0].options.method, "POST");
assert.deepEqual(JSON.parse(calls[0].options.body), {
  startDate: 1,
  endDate: 2,
  onlyFailures: false,
});
assert.match(calls[0].options.headers.authorization, /^Bearer /);

await client.getAllSubscriptionStatuses("Sandbox", "transaction/id");
assert.equal(
  calls[1].url,
  "https://sandbox.example.test/inApps/v1/subscriptions/transaction%2Fid",
);
assert.equal(calls[1].options.method, "GET");

const testRequest = await client.requestTestNotification("Production");
assert.equal(testRequest.testNotificationToken, "test-token");
assert.equal(
  calls[2].url,
  "https://production.example.test/inApps/v1/notifications/test",
);

await client.getTestNotificationStatus("Production", "token/id");
assert.equal(
  calls[3].url,
  "https://production.example.test/inApps/v1/notifications/test/token%2Fid",
);

await client.sendConsumptionInformation("Sandbox", "transaction/id", {
  customerConsented: true,
  deliveryStatus: "DELIVERED",
  refundPreference: "GRANT_FULL",
  sampleContentProvided: true,
});
assert.equal(
  calls[4].url,
  "https://sandbox.example.test/inApps/v2/transactions/consumption/transaction%2Fid",
);
assert.equal(calls[4].options.method, "PUT");
assert.deepEqual(JSON.parse(calls[4].options.body), {
  customerConsented: true,
  deliveryStatus: "DELIVERED",
  refundPreference: "GRANT_FULL",
  sampleContentProvided: true,
});

const errorClient = new AppleServerAPIClient({
  issuerId: "issuer-id",
  keyId: "KEY123",
  bundleId: "SyengUp.FridayNext",
  privateKey,
  fetchImpl: async () =>
    new Response(JSON.stringify({ errorCode: 4040006 }), { status: 429 }),
});
await assert.rejects(
  () => errorClient.getAllSubscriptionStatuses("Production", "123"),
  (error) =>
    error instanceof AppleServerAPIError &&
    error.status === 429 &&
    error.retryable === true &&
    error.body.errorCode === 4040006,
);
await assert.rejects(
  () => client.getAllSubscriptionStatuses("invalid", "123"),
  /invalid_apple_environment/,
);

console.log("✅ App Store Server API JWT, routes, pagination and errors");
