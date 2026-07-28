# P5 StoreKit / ASSN v2 deployment

> Current status (2026-07-23): app, plugin, Apple verifier/roots, webhook, App Attest and the
> frps entitlement gate are implemented. FridayTunnel no longer has a server-managed 30-day
> trial or pairing bootstrap. Pairing stays on the local network; the customer trial is Apple's
> introductory offer.

## App Store Connect

- Auto-renewable subscription product ID: `SyengUp.FridayNext.Tunnel.yearly`
- One yearly product only; mainland China target price is ¥68/year (raised from ¥38 on 2026-07-28).
- Configure an introductory offer on this product: **Free / 2 Weeks**.
- Configure App Store Server Notifications v2 production and sandbox URL as
  `https://friday.syengup.host/v1/apple/webhook`.
- Publish the reviewed legal pages on GitHub Pages:
  `https://syengup.github.io/FridayNext-Privacy/` and
  `https://syengup.github.io/FridayNext-Privacy/terms.html` before App Review.

The app asks StoreKit for the real introductory offer and
`Product.SubscriptionInfo.isEligibleForIntroOffer`. It shows free-trial copy only when both the
offer and eligibility are present; otherwise it shows the normal yearly purchase. StoreKit applies
the eligible offer automatically when `purchase(options:)` is called.

The app attaches the existing iCloud-Keychain UUID as `appAccountToken`.
`/v1/apple/transactions/verify` accepts only a transaction whose signed bundle/product/account
values match. An active transaction with `offerType=1` becomes server state `trial`; a later normal
renewal becomes `active`.

## Relay prerequisites

These prerequisites are already installed on the production relay.

1. Copy `apple-jws.js` and `apple-server-api.js` beside `/opt/gw-alloc/server.js`.
2. Run `relay/deploy/install-apple-roots.sh` on the relay.
3. Keep these non-secret systemd environment values:

```ini
Environment=APPLE_SUBSCRIPTION_PRODUCT_ID=SyengUp.FridayNext.Tunnel.yearly
Environment=APPLE_AVAILABLE_STOREFRONTS=CHN
Environment=APPLE_ROOT_CA_FILES=/opt/gw-alloc/apple-roots/AppleRootCA-G2.cer:/opt/gw-alloc/apple-roots/AppleRootCA-G3.cer
```

Both Apple endpoints fail closed with `503 apple_verifier_not_configured` when roots are absent.

The public control-plane locations must not write Nginx access logs. Subscription, entitlement,
App Attest and security events already have a purpose-built audit trail; duplicating request IPs,
paths and user agents in the generic web access log is unnecessary.

```nginx
location /gw-alloc/ {
    access_log off;
    proxy_pass http://127.0.0.1:7001/;
}

location /v1/ {
    access_log off;
    limit_req zone=fncp burst=20 nodelay;
    proxy_pass http://127.0.0.1:7003;
}
```

Create an App Store Connect **In-App Purchase** key (Users and Access → Integrations → In-App
Purchase), download its `.p8` once, and install it outside the repository with mode `0600`. Add a
root-only systemd drop-in:

```ini
[Service]
Environment=APPLE_SERVER_API_ISSUER_ID=<issuer UUID>
Environment=APPLE_SERVER_API_KEY_ID=<key ID>
Environment=APPLE_SERVER_API_PRIVATE_KEY_FILE=/opt/gw-alloc/secrets/SubscriptionKey_<key ID>.p8
Environment=APPLE_SERVER_API_RECONCILE_INTERVAL_SEC=900
Environment=APPLE_SERVER_API_RECONCILE_LOOKBACK_SEC=86400
```

The control plane then runs two independent repairs every 15 minutes: it replays signed ASSN v2
history with a five-minute overlapping cursor, and asks `Get All Subscription Statuses` for every
known original transaction. API failures never grant or revoke by inference; only Apple-signed
transactions pass into the existing entitlement state machine. Operators can also run:

```text
POST /v1/admin/apple/reconcile
POST /v1/admin/apple/test-notification
POST /v1/admin/apple/test-notification-status
```

All three endpoints require `GW_ALLOC_ADMIN_TOKEN`.

## Automatic production refund recommendations

`CONSUMPTION_REQUEST` is handled automatically; there is no FridayNext manual-approval queue.
The server responds to Apple with delivery facts and, when the evidence is clear, a refund
preference. Apple remains the final decision maker and reports its result through `REFUND` or
`REFUND_DECLINED`.

- Sandbox always recommends `GRANT_FULL` so refund-chain testing is deterministic.
- Production recommends `GRANT_FULL` when FridayTunnel was never activated for the account, the
  service killswitch indicates an outage, or Apple identifies a legal reason.
- Production omits `refundPreference` after normal delivery when there is no strong signal, which
  explicitly leaves the decision to Apple.
- Production recommends `DECLINE` only when the account activated FridayTunnel and Apple has
  already confirmed at least two earlier refunds.

Only Production `REFUND` and `REFUND_DECLINED` outcomes enter the bounded, transaction-ID
idempotent `appleRefundHistory`; Sandbox activity cannot affect production decisions. The policy
does not inspect tunnel contents and does not treat attachment-only OSS bytes as total service
usage. Every response records its policy reason and signals in the monthly audit log. A failed
App Store Server API response returns HTTP 502 from the webhook so Apple retries the notification.

Successful consumption responses are persisted by Apple `notificationUUID` (bounded to the latest
2,000). Webhook retries, overlapping Notification History and control-plane restarts therefore
cannot resubmit the same one-shot response. A later refund request for the same transaction has a
new UUID and is still processed normally; concurrent delivery is also guarded in memory.

`APPLE_PRODUCTION_REFUND_PREFERENCE=GRANT_FULL|GRANT_PRORATED|DECLINE` remains an emergency
operator override. Leave it unset for the evidence-based policy above.

## Production switches

```ini
CP_ATTEST_REQUIRE=1
CP_ENFORCE_GRANTS=1
GW_RELAY_BOOTSTRAP=1
GW_FRPS_RESTART=1
```

Optional: `OSS_EGRESS_BURST_FACTOR` (default `4`) is the multiple of the monthly attachment cap a
tunnel may download before `/v1/oss/sign` starts refusing GETs. Downloads stay far more generous
than uploads — re-fetching paid blobs on a new device is normal — but egress is billed per GB, so
it is no longer unbounded.

Optional: `CP_ATTEST_KEYS_MAX` (default `500`) and `CP_ATTEST_KEY_DEAD_AFTER_SEC` (default `86400`)
bound the attested App Attest key table. It previously only ever grew: one device had accumulated
77 keys, 37 of them never asserted after attestation, because the app shared a single App Attest
key id between this control plane and the gateway plugin — each server rejected the other's key as
`unknown_key`, forcing a fresh full attestation every cold start. The app now keeps one key per
server; the ceiling here is what stops any other client from refilling the table. A key is dropped
when it was never asserted and is older than `CP_ATTEST_KEY_DEAD_AFTER_SEC`, or when the table
exceeds `CP_ATTEST_KEYS_MAX` (least-recently-active evicted first). Pruning runs at boot inside
`gcState()` and on every new attestation, and every eviction is audited as `attest.keys.pruned` —
an evicted key simply means that client re-attests on its next activation.
`relay/attest-key-prune.js` holds the decision; `node relay/test-attest-key-prune.mjs` covers it.

Optional: `CP_EXPIRY_SWEEP_SEC` (default `600`) and `CP_EXPIRY_SWEEP_COOLDOWN_SEC` (default `3600`)
tune the ENFORCE_GRANTS expiry sweep. The sweep now forces at most ONE frps re-registration per
subdomain per registration episode and then forgets a subdomain that never came back — an offline
gateway used to make it restart frps (relay-wide, personal tunnels included) on every tick forever.
`relay/expiry-sweep.js` holds the decision; `node relay/test-expiry-sweep.mjs` covers it.

`POST /v1/tunnels/reserve` is retired and answers `410 reserve_retired`. Pairing is LAN-only and
the one-time voucher is minted by the gateway plugin; the endpoint was unauthenticated and wrote
durable state on every call.

`CP_BOOTSTRAP_ENABLED` and `CP_BOOTSTRAP_TTL_SEC` are retired and ignored by the server. Remove
them from systemd when convenient; leaving stale values behind cannot reopen a pairing tunnel.
New pairing records remain `none`/unentitled and create neither a grant nor a public proxy.

On rollout, an existing `free-test` or `server-trial` row is migrated on first read: an unexpired
row is clamped to at most 30 minutes and an expired row remains expired. Apple rows are untouched.
The legacy `.bootstrap` state remains readable only so an in-flight rollout does not corrupt an
already-issued short grant; this build never creates a new one. `CP_FREE_TEST` and
`CP_TRIAL_ENABLED` are obsolete and are not consulted by the server.

`GW_RELAY_BOOTSTRAP` is unrelated to customer trial/bootstrap state: it distributes the semi-public
frps material needed by a gateway. The authoritative boundaries remain
`/v1/gateway/standby`'s entitlement-only desired set plus the frps `NewProxy` plugin.

## Public-surface App Attest gate

Gateway-side config, `channels.friday-next.appAttest`:

| Key | Default | Effect |
| --- | --- | --- |
| `required` | `true` | Gate `/friday-next/*` and `/friday-next-admin/*` on a valid session token. Public surface only — LAN never carries the proxy's marker and is never gated. |
| `gatePublicSurfaces` | `true` | Also gate `/gateway` (node WebSocket) and `/__openclaw__/*` (canvas) **in the filter proxy**. |
| `allowDevelopment` | `true` | Accept development-environment attestations. Keep `true` while distributing ad-hoc/TestFlight builds; tightening it before App Store distribution locks out your own devices. |

`gatePublicSurfaces` closes a real hole: those two paths are core-owned, so the plugin registers no
handler for them and its own gate never sees them. Until this landed, a leaked gateway bearer
reached the node WebSocket and the whole canvas surface from the public internet, and canvas
sub-resources carried no credential at all — WebKit does not propagate a top-level navigation's
headers to the JS/CSS/XHR the page then issues. The app therefore presents the token two ways: an
`X-FridayNext-Attest` header on the WebSocket upgrade, and an `fn_attest` cookie (Secure, HttpOnly,
host-scoped) for canvas. The cookie is accepted for `/__openclaw__/*` only, so it can never stand
in as a credential for the REST API or the node WebSocket.

The proxy deliberately does NOT gate `/friday-next/*`: the plugin gates those downstream and owns
the exemption table (`/attest/*`, `/pair/claim`, `/health`, …). Re-gating them here would make
pairing impossible, since those endpoints are pre-token by construction.

**This requires an app build that sends both carriers.** A gateway on this plugin version with an
older app loses canvas, location and the node WebSocket over the public path — chat keeps working.
Set `gatePublicSurfaces: false` to fall back to bearer-only on those two paths.

`src/attest/attest-gate.ts` holds the decision (shared by all three call sites);
`src/attest/attest-gate.test.ts` and `src/public-access/filter-proxy.boot.test.ts` cover it, the
latter by booting the real proxy against a stub core.

## Launch verification

1. Configure the Free / 2 Weeks introductory offer in App Store Connect.
2. Use a fresh eligible sandbox account, or reset the existing tester's introductory-offer
   eligibility: Settings → Apple Account → Media & Purchases → Sandbox Account → Manage → select
   the expired subscription → Reset Eligibility. Clearing purchase history alone is not the
   eligibility reset workflow.
3. Pair on the same local network: verify the control plane remains `none`, no grant is created,
   `/v1/gateway/standby` returns an empty desired-subdomain set, and no frpc proxy starts.
4. Start the Apple trial: verify the signed transaction reports `offerType=1`, the control plane
   reports `trial`, the dormant gateway wakes and becomes reachable from cellular, and the app
   shows the Apple expiry countdown plus “管理订阅”.
5. Exercise renewal, restore, cancellation, expiry and refund. Confirm `apple.transaction` /
   `apple.notification` audit events, environment-appropriate grace, and immediate grant removal
   on refund.

Do not restore a pairing bootstrap as an emergency bypass. Use an App Store entitlement fix or a
separately audited operator grant so pairing itself never becomes public-access authorization.

## Deferred follow-ups

These items were explicitly deferred after the StoreKit delivery/sync state-machine fixes. Keep
them open for the next P5 hardening pass:

- [x] Add App Store Server API reconciliation (`Get Notification History` plus current subscription
  status) so a notification missed during an outage cannot interrupt an otherwise-paid tunnel.
- [ ] Re-run the App Store Server Notifications v2 production TEST notification after Apple makes
  the app/product available to the production API. Sandbox TEST delivery and webhook processing
  were verified on 2026-07-23; the production request currently returns 404 from Apple.
- [x] Run the complete China-storefront physical-device sandbox matrix: new eligible user, 14-day
  introductory trial, renewal, cancellation, expiry, restore, refund, and immediate grant removal.
- [x] Extract and translate the new FridayTunnel subscription strings in `Localizable.xcstrings`.
- [x] Finish the UI terminology pass from “局域网” to “本地连接”.
- [x] Correct this deployment guide's stale “Free / 1 Month” and purchase-history-reset instructions
  to the current 14-day offer and Sandbox “Reset Eligibility” workflow.
