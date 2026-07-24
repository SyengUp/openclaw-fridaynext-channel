# P5 StoreKit / ASSN v2 deployment

> Current status (2026-07-23): app, plugin, Apple verifier/roots, webhook, App Attest and the
> frps entitlement gate are implemented. FridayTunnel no longer has a server-managed 30-day
> trial. Pairing gets a one-time short bootstrap; the customer trial is Apple's introductory offer.

## App Store Connect

- Auto-renewable subscription product ID: `SyengUp.FridayNext.Tunnel.yearly`
- One yearly product only; mainland China target price is ¥38/year.
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
CP_BOOTSTRAP_ENABLED=1
CP_BOOTSTRAP_TTL_SEC=1800
CP_ATTEST_REQUIRE=1
CP_ENFORCE_GRANTS=1
GW_RELAY_BOOTSTRAP=1
GW_FRPS_RESTART=1
```

`CP_BOOTSTRAP_ENABLED` grants a stable `appAccountToken` one pairing entitlement only.
`bootstrapHistory` prevents deletion, reinstall or expiry from reseeding it. Grant TTL is capped at
the bootstrap boundary. Subscription verification, grant renewal and OSS signing never create a
bootstrap.

On rollout, an existing `free-test` or `server-trial` row is migrated on first read: an unexpired
row is clamped to at most the configured bootstrap TTL and an expired row remains expired. Apple
and activation-code rows are untouched. `CP_FREE_TEST` and `CP_TRIAL_ENABLED` are obsolete and are
not consulted by the server.

`GW_RELAY_BOOTSTRAP` is unrelated to customer trial/bootstrap state: it distributes the semi-public
frps material needed by a gateway. The authoritative boundaries remain
`/v1/gateway/standby`'s entitlement-only desired set plus the frps `NewProxy` plugin.

## Launch verification

1. Configure the Free / 2 Weeks introductory offer in App Store Connect.
2. Use a fresh eligible sandbox account, or reset the existing tester's introductory-offer
   eligibility: Settings → Apple Account → Media & Purchases → Sandbox Account → Manage → select
   the expired subscription → Reset Eligibility. Clearing purchase history alone is not the
   eligibility reset workflow.
3. Pair: verify the control plane reports `bootstrap`, a grant TTL no greater than 1800 seconds,
   and the subscription page opens immediately after onboarding.
4. Start the Apple trial: verify the signed transaction reports `offerType=1`, the control plane
   reports `trial`, and the app shows the Apple expiry countdown plus “管理订阅”.
5. Exercise renewal, restore, cancellation, expiry and refund. Confirm `apple.transaction` /
   `apple.notification` audit events, environment-appropriate grace, and immediate grant removal
   on refund.

Emergency rollback should use the admin activation-code path or temporarily lengthen
`CP_BOOTSTRAP_TTL_SEC` (maximum one day). Do not re-enable a server-managed 30-day trial, because it
would restore the conversion problem this design removes.

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
