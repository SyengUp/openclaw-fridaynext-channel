#!/usr/bin/env node
// 生产控制面(gw-alloc-server.js /v1)本地实证测试。
// 起真实服务进程(临时数据目录+高位端口),打满:契约端点/生产 claim 语义/attest 拒绝/
// 配额/Apple优惠代码/webhook 回收/admin 吊销+killswitch→闸门联动/个人隧道零打扰/持久化重启存活。
// 运行:node relay/test-control-plane.mjs   (在插件仓库根,node-app-attest 可解析)
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "gw-alloc-server.js");
const ALLOC = 17001,
  GATE = 17002,
  CP = 17003,
  APPLE_PRODUCTION_API = 17997,
  APPLE_SANDBOX_API = 17998;
const TOKEN = "test-bearer-token"; // GW_ALLOC_TOKEN (allocate/sign + frps token, semi-public)
const ADMIN = "test-admin-token"; // GW_ALLOC_ADMIN_TOKEN (operator-only admin)
const dataDir = mkdtempSync(join(tmpdir(), "gwalloc-test-"));

// Local Apple-shaped trust chain + ES256 signer. Production uses Apple PKI roots; this generated
// chain exercises the exact x5c/OID/signature/bundle/product/account path without network access.
const appleDir = join(dataDir, "apple-jws");
mkdirSync(appleDir);
const appleRootKey = join(appleDir, "root.key");
const appleRootPem = join(appleDir, "root.pem");
const appleLeafKey = join(appleDir, "leaf.key");
const appleLeafCSR = join(appleDir, "leaf.csr");
const appleLeafPem = join(appleDir, "leaf.pem");
const appleLeafDer = join(appleDir, "leaf.der");
const appleLeafExt = join(appleDir, "leaf.ext");
execFileSync("openssl", [
  "ecparam",
  "-name",
  "prime256v1",
  "-genkey",
  "-noout",
  "-out",
  appleRootKey,
]);
execFileSync("openssl", [
  "req",
  "-x509",
  "-new",
  "-key",
  appleRootKey,
  "-subj",
  "/CN=Test Apple Root",
  "-days",
  "30",
  "-out",
  appleRootPem,
]);
execFileSync("openssl", [
  "ecparam",
  "-name",
  "prime256v1",
  "-genkey",
  "-noout",
  "-out",
  appleLeafKey,
]);
execFileSync("openssl", [
  "req",
  "-new",
  "-key",
  appleLeafKey,
  "-subj",
  "/CN=Test App Store",
  "-out",
  appleLeafCSR,
]);
writeFileSync(
  appleLeafExt,
  "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n1.2.840.113635.100.6.11.1=DER:05:00\n",
);
execFileSync("openssl", [
  "x509",
  "-req",
  "-in",
  appleLeafCSR,
  "-CA",
  appleRootPem,
  "-CAkey",
  appleRootKey,
  "-CAcreateserial",
  "-days",
  "30",
  "-extfile",
  appleLeafExt,
  "-out",
  appleLeafPem,
]);
execFileSync("openssl", ["x509", "-in", appleLeafPem, "-outform", "DER", "-out", appleLeafDer]);
const appleJWSHeader = { alg: "ES256", x5c: [readFileSync(appleLeafDer).toString("base64")] };
const b64url = (value) => Buffer.from(value).toString("base64url");
function signAppleJWS(payload) {
  const input = `${b64url(JSON.stringify(appleJWSHeader))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign("sha256", Buffer.from(input), {
    key: readFileSync(appleLeafKey),
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${b64url(signature)}`;
}

const appleAPIFixtures = {
  Production: { notifications: [], statuses: new Map(), consumptionRequests: [] },
  Sandbox: { notifications: [], statuses: new Map(), consumptionRequests: [] },
};
function createAppleAPIMock(environment, port) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && url.pathname === "/inApps/v1/notifications/history") {
      response.end(
        JSON.stringify({
          notificationHistory: appleAPIFixtures[environment].notifications,
          hasMore: false,
        }),
      );
      return;
    }
    const subscriptionMatch = url.pathname.match(/^\/inApps\/v1\/subscriptions\/([^/]+)$/);
    if (request.method === "GET" && subscriptionMatch) {
      const transactionId = decodeURIComponent(subscriptionMatch[1]);
      response.end(
        JSON.stringify(
          appleAPIFixtures[environment].statuses.get(transactionId) || {
            bundleId: "SyengUp.FridayNext",
            environment,
            data: [],
          },
        ),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/inApps/v1/notifications/test") {
      response.end(JSON.stringify({ testNotificationToken: `${environment}-test-token` }));
      return;
    }
    const consumptionMatch = url.pathname.match(
      /^\/inApps\/v2\/transactions\/consumption\/([^/]+)$/,
    );
    if (request.method === "PUT" && consumptionMatch) {
      const transactionId = decodeURIComponent(consumptionMatch[1]);
      let raw = "";
      for await (const chunk of request) raw += chunk;
      if (transactionId === "49999") {
        response.statusCode = 503;
        response.end(JSON.stringify({ errorCode: 5000001 }));
        return;
      }
      appleAPIFixtures[environment].consumptionRequests.push({
        transactionId,
        body: JSON.parse(raw),
      });
      response.statusCode = 202;
      response.end();
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === `/inApps/v1/notifications/test/${environment}-test-token`
    ) {
      response.end(
        JSON.stringify({
          signedPayload: "test",
          sendAttempts: [{ attemptDate: Date.now(), sendAttemptResult: "SUCCESS" }],
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ errorCode: 4040006 }));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
const appleProductionMock = await createAppleAPIMock("Production", APPLE_PRODUCTION_API);
const appleSandboxMock = await createAppleAPIMock("Sandbox", APPLE_SANDBOX_API);

// Ownership proof (P0-4): activate's first-time claim needs gatewayKey = the allocation key.
// The test allocates each subdomain under `<letter>*64`, so that letter's key claims it.
const keyForSub = new Map(); // subdomain → allocation hex key

let child = null;
function startServer(extraEnv = {}) {
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      GW_ALLOC_DATA_DIR: dataDir,
      GW_ALLOC_PORT: String(ALLOC),
      FRP_GATE_PORT: String(GATE),
      CP_PORT: String(CP),
      GW_ALLOC_TOKEN: TOKEN,
      GW_ALLOC_ADMIN_TOKEN: ADMIN,
      GW_FRPS_RESTART: "0", // no real `systemctl restart frps` in tests (revoke/killswitch call it)
      CP_BOOTSTRAP_ENABLED: "1",
      CP_BOOTSTRAP_TTL_SEC: "1800",
      OSS_MOCK_BASE: "http://127.0.0.1:17999",
      OSS_CAP_TRIAL: String(1024), // 1KB trial cap → easy quota test
      APPLE_ROOT_CA_FILES: appleRootPem,
      APPLE_AVAILABLE_STOREFRONTS: "chn, USA,CHN,invalid",
      APPLE_SERVER_API_ISSUER_ID: "test-issuer",
      APPLE_SERVER_API_KEY_ID: "TESTKEY",
      APPLE_SERVER_API_PRIVATE_KEY_FILE: appleLeafKey,
      APPLE_SERVER_API_PRODUCTION_URL: `http://127.0.0.1:${APPLE_PRODUCTION_API}`,
      APPLE_SERVER_API_SANDBOX_URL: `http://127.0.0.1:${APPLE_SANDBOX_API}`,
      APPLE_SERVER_API_RECONCILE_INTERVAL_SEC: "0",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error("server didn't start: " + out)), 5000);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("control-plane")) {
        clearTimeout(t);
        resolve();
      }
    });
  });
}
function stopServer() {
  return new Promise((r) => {
    if (!child) return r();
    child.on("exit", r);
    child.kill();
    child = null;
  });
}

async function req(port, path, { method = "POST", body, bearer } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, json };
}

let passed = 0,
  failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const U1 = "aat-user-1",
  U2 = "aat-user-2";
const DEV = "device-abc";

try {
  await startServer();
  console.log("— 基础 —");
  let r = await req(CP, "/v1/healthz", { method: "GET" });
  check("healthz", r.status === 200 && r.json.ok === true && r.json.killswitch === false);

  // 安装器引导:无 bearer 就能拿到 frps 地址+共用 token(邀请制 beta 的有意选择),
  // 且必须能被 GW_RELAY_BOOTSTRAP=0 关掉——那是 P5 的闸门,不需要重发安装器。
  r = await req(CP, "/v1/relay/bootstrap", { method: "GET" });
  check(
    "bootstrap 免鉴权可取凭据",
    r.status === 200 && r.json.relayToken === TOKEN && typeof r.json.relayAddr === "string",
  );
  check("bootstrap 不泄露 admin token", JSON.stringify(r.json).includes(ADMIN) === false);

  r = await req(ALLOC, "/allocate", { body: { key: "a".repeat(64) } });
  check("allocate 无 bearer 401", r.status === 401);
  r = await req(ALLOC, "/allocate", { body: { key: "a".repeat(64) }, bearer: TOKEN });
  check("allocate ok", r.status === 200 && /^fn[0-9a-f]{10}$/.test(r.json.subdomain));
  const SUB = r.json.subdomain;
  keyForSub.set(SUB, "a".repeat(64));
  // 幂等
  const r2 = await req(ALLOC, "/allocate", { body: { key: "a".repeat(64) }, bearer: TOKEN });
  check("allocate 幂等", r2.json.subdomain === SUB);

  console.log("— activate(生产 claim 语义)—");
  r = await req(CP, "/v1/tunnels/activate", {
    body: { mode: "seamless", gatewayId: "gw1", appAccountToken: U1, deviceId: DEV },
  });
  check(
    "缺 subdomain → 400 subdomain_required",
    r.status === 400 && r.json.error === "subdomain_required",
  );
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gw1",
      appAccountToken: U1,
      deviceId: DEV,
      subdomain: "fnnotexist99",
    },
  });
  check("未分配 subdomain → 404", r.status === 404 && r.json.error === "subdomain_not_allocated");
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gw1",
      appAccountToken: U1,
      deviceId: DEV,
      subdomain: SUB,
      gatewayKey: keyForSub.get(SUB),
    },
  });
  check(
    "claim 已分配子域 → 200",
    r.status === 200 && r.json.subdomain === SUB,
    JSON.stringify(r.json),
  );
  check("publicUrl 正确", r.json?.publicUrl === `https://${SUB}.bj.gw.syengup.host`);
  check(
    "bootstrap grant 按短时权益签发",
    typeof r.json?.grantId === "string" &&
      r.json.grantTtlSec > 1700 &&
      r.json.grantTtlSec <= 1800,
  );
  const GRANT = r.json.grantId,
    TUNNEL = r.json.tunnelId;
  // FQDN 形式也接受
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gw1",
      appAccountToken: U1,
      deviceId: DEV,
      subdomain: `${SUB}.bj.gw.syengup.host`,
      gatewayKey: keyForSub.get(SUB),
    },
  });
  check("FQDN subdomain 归一化 + 隧道复用", r.status === 200 && r.json.tunnelId === TUNNEL);

  console.log("— 配对短时 bootstrap —");
  r = await req(CP, "/v1/subscriptions/verify", { body: { appAccountToken: U1 } });
  check(
    "首次 activate 自动种 bootstrap",
    r.status === 200 && r.json.state === "bootstrap" && r.json.entitled === true,
  );
  r = await req(CP, "/v1/subscriptions/verify", { body: { appAccountToken: "never-seen" } });
  check("未见过 token → none", r.json.state === "none" && r.json.entitled === false);
  check(
    "销售地区动态配置归一化并去重",
    JSON.stringify(r.json.availableStorefronts) === JSON.stringify(["CHN", "USA"]),
  );

  console.log("— attest —");
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gw1",
      appAccountToken: U1,
      deviceId: DEV,
      subdomain: SUB,
      attestation: {
        token: Buffer.from("garbage").toString("base64"),
        keyId: "k1",
        kind: "appattest-attest",
      },
    },
  });
  check(
    "伪造 attestation → 403 attest_rejected",
    r.status === 403 && r.json.error === "attest_rejected",
    `got ${r.status} ${JSON.stringify(r.json)}`,
  );
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gw1",
      appAccountToken: U1,
      deviceId: DEV,
      subdomain: SUB,
      attestation: { token: "mock-x", keyId: null, kind: "mock" },
    },
  });
  check("mock attest(测试期)放行", r.status === 200);
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gw1",
      appAccountToken: U1,
      deviceId: DEV,
      subdomain: SUB,
      attestation: {
        token: Buffer.from("garbage").toString("base64"),
        keyId: "k-unknown",
        kind: "appattest-assert",
      },
    },
  });
  check("未知 key 的 assertion(测试期)放行+标记", r.status === 200);

  console.log("— 配额(cap=3)—");
  const subs = [SUB];
  for (const k of ["b", "c", "d"]) {
    const a = await req(ALLOC, "/allocate", { body: { key: k.repeat(64) }, bearer: TOKEN });
    subs.push(a.json.subdomain);
    keyForSub.set(a.json.subdomain, k.repeat(64));
  }
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gw2",
      appAccountToken: U1,
      deviceId: DEV,
      subdomain: subs[1],
      gatewayKey: keyForSub.get(subs[1]),
    },
  });
  check("第2条隧道 ok", r.status === 200);
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gw3",
      appAccountToken: U1,
      deviceId: DEV,
      subdomain: subs[2],
      gatewayKey: keyForSub.get(subs[2]),
    },
  });
  check("第3条隧道 ok", r.status === 200);
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gw4",
      appAccountToken: U1,
      deviceId: DEV,
      subdomain: subs[3],
      gatewayKey: keyForSub.get(subs[3]),
    },
  });
  check(
    "第4条 → 409 tunnel_cap_reached",
    r.status === 409 && r.json.error === "tunnel_cap_reached" && r.json.cap === 3,
  );
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gwX",
      appAccountToken: U2,
      deviceId: DEV,
      subdomain: subs[3],
      gatewayKey: keyForSub.get(subs[3]),
    },
  });
  check("另一 AppleID claim 同网关不受 U1 配额影响", r.status === 200);

  console.log("— reserve 路径 —");
  r = await req(CP, "/v1/tunnels/reserve", { body: { gatewayId: "gw-rsv" } });
  check(
    "reserve ok",
    r.status === 200 && r.json.ttlSec === 600 && typeof r.json.reservationId === "string",
  );
  const RSV = r.json.reservationId;
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      reservationId: RSV,
      appAccountToken: U2,
      deviceId: DEV,
      subdomain: subs[3],
      gatewayKey: keyForSub.get(subs[3]),
    },
  });
  check("reservation activate ok", r.status === 200);
  r = await req(CP, "/v1/tunnels/activate", {
    body: { reservationId: "nope", appAccountToken: U2, deviceId: DEV, subdomain: subs[3] },
  });
  check("未知 reservation → 404", r.status === 404 && r.json.error === "reservation_not_found");

  console.log("— grant 续期 —");
  r = await req(CP, "/v1/grants/renew", { body: { grantId: GRANT } });
  check(
    "renew 不越过 bootstrap 边界",
    r.status === 200 &&
      r.json.expiresAt > Date.now() + 1700_000 &&
      r.json.expiresAt <= Date.now() + 1800_000,
  );
  r = await req(CP, "/v1/grants/renew", { body: { grantId: "nope" } });
  check("未知 grant → 404", r.status === 404 && r.json.error === "grant_not_found");

  console.log("— 自建激活码端点已退役 —");
  r = await req(CP, "/v1/codes/issue", {
    body: { code: "GIFT1", days: 365 },
    bearer: ADMIN,
  });
  check("服务端不再签发自建激活码", r.status === 404);
  r = await req(CP, "/v1/codes/redeem", {
    body: { code: "GIFT1", appAccountToken: U2 },
  });
  check("服务端不再接受自建激活码", r.status === 404);

  console.log("— StoreKit 2 + ASSN v2 JWS —");
  const APPLE_USER = "00000000-0000-4000-8000-000000000002";
  const transactionBase = {
    bundleId: "SyengUp.FridayNext",
    productId: "SyengUp.FridayNext.Tunnel.yearly",
    appAccountToken: APPLE_USER,
    transactionId: "42001",
    originalTransactionId: "42000",
    expiresDate: Date.now() + 365 * 86400_000,
    signedDate: Date.now(),
    environment: "Sandbox",
  };
  const activeJWS = signAppleJWS(transactionBase);
  r = await req(CP, "/v1/apple/transactions/verify", {
    body: { signedTransaction: activeJWS, appAccountToken: APPLE_USER },
  });
  check("客户端签名交易验真 → active", r.status === 200 && r.json.state === "active");

  const INTRO_USER = "00000000-0000-4000-8000-000000000006";
  const introJWS = signAppleJWS({
    ...transactionBase,
    appAccountToken: INTRO_USER,
    transactionId: "46001",
    originalTransactionId: "46000",
    offerType: 1,
  });
  r = await req(CP, "/v1/apple/transactions/verify", {
    body: { signedTransaction: introJWS, appAccountToken: INTRO_USER },
  });
  check(
    "Apple introductory offer 交易 → trial",
    r.status === 200 && r.json.state === "trial" && r.json.entitled === true,
  );

  const OFFER_CODE_USER = "00000000-0000-4000-8000-000000000007";
  const offerCodeJWS = signAppleJWS({
    ...transactionBase,
    appAccountToken: undefined,
    transactionId: "47001",
    originalTransactionId: "47000",
    offerType: 3,
  });
  r = await req(CP, "/v1/apple/transactions/verify", {
    body: { signedTransaction: offerCodeJWS, appAccountToken: OFFER_CODE_USER },
  });
  check(
    "Apple Offer Code 无 appAccountToken 首次绑定 → active",
    r.status === 200 && r.json.state === "active" && r.json.entitled === true,
  );
  r = await req(CP, "/v1/apple/transactions/verify", {
    body: { signedTransaction: offerCodeJWS, appAccountToken: crypto.randomUUID() },
  });
  check("Offer Code originalTransactionId 不能换绑", r.status === 403);
  r = await req(CP, "/v1/apple/transactions/verify", {
    body: { signedTransaction: activeJWS, appAccountToken: crypto.randomUUID() },
  });
  check("交易 appAccountToken 不匹配 → 403", r.status === 403);

  const EXPIRED_SANDBOX_USER = "00000000-0000-4000-8000-000000000003";
  const expiredSandboxJWS = signAppleJWS({
    ...transactionBase,
    appAccountToken: EXPIRED_SANDBOX_USER,
    transactionId: "43001",
    originalTransactionId: "43000",
    expiresDate: Date.now() - 6 * 60_000,
    signedDate: Date.now(),
    environment: "Sandbox",
  });
  r = await req(CP, "/v1/apple/transactions/verify", {
    body: {
      signedTransaction: expiredSandboxJWS,
      appAccountToken: EXPIRED_SANDBOX_USER,
    },
  });
  check(
    "Sandbox 到期超过默认5分钟宽限 → expired",
    r.status === 200 && r.json.state === "expired" && r.json.entitled === false,
  );

  const RECENT_SANDBOX_USER = "00000000-0000-4000-8000-000000000004";
  const recentSandboxJWS = signAppleJWS({
    ...transactionBase,
    appAccountToken: RECENT_SANDBOX_USER,
    transactionId: "44001",
    originalTransactionId: "44000",
    expiresDate: Date.now() - 2 * 60_000,
    signedDate: Date.now(),
    environment: "Sandbox",
  });
  r = await req(CP, "/v1/apple/transactions/verify", {
    body: {
      signedTransaction: recentSandboxJWS,
      appAccountToken: RECENT_SANDBOX_USER,
    },
  });
  check(
    "Sandbox 到期仍在默认5分钟宽限 → grace",
    r.status === 200 && r.json.state === "grace" && r.json.entitled === true,
  );

  const RECENT_PRODUCTION_USER = "00000000-0000-4000-8000-000000000005";
  const recentProductionJWS = signAppleJWS({
    ...transactionBase,
    appAccountToken: RECENT_PRODUCTION_USER,
    transactionId: "45001",
    originalTransactionId: "45000",
    expiresDate: Date.now() - 6 * 60_000,
    signedDate: Date.now(),
    environment: "Production",
  });
  r = await req(CP, "/v1/apple/transactions/verify", {
    body: {
      signedTransaction: recentProductionJWS,
      appAccountToken: RECENT_PRODUCTION_USER,
    },
  });
  check(
    "Production 保留72小时服务宽限",
    r.status === 200 && r.json.state === "grace" && r.json.entitled === true,
  );

  const appleAlloc = await req(ALLOC, "/allocate", {
    body: { key: "7".repeat(64) },
    bearer: TOKEN,
  });
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gw-apple",
      appAccountToken: APPLE_USER,
      deviceId: DEV,
      subdomain: appleAlloc.json.subdomain,
      gatewayKey: "7".repeat(64),
    },
  });
  check("Apple 订阅可签发 grant", r.status === 200 && typeof r.json.grantId === "string");

  const consumptionPayload = signAppleJWS({
    notificationType: "CONSUMPTION_REQUEST",
    notificationUUID: crypto.randomUUID(),
    signedDate: Date.now(),
    data: {
      bundleId: "SyengUp.FridayNext",
      environment: "Sandbox",
      consumptionRequestReason: "UNINTENDED_PURCHASE",
      signedTransactionInfo: activeJWS,
    },
  });
  r = await req(CP, "/v1/apple/webhook", { body: { signedPayload: consumptionPayload } });
  check(
    "Sandbox 退款消费信息自动回传 Apple",
    r.status === 200 &&
      appleAPIFixtures.Sandbox.consumptionRequests.some(
        (item) =>
          item.transactionId === transactionBase.transactionId &&
          item.body.refundPreference === "GRANT_FULL" &&
          item.body.customerConsented === true &&
          item.body.consumptionPercentage === undefined,
      ),
  );

  const consumptionCountAfterFirstResponse =
    appleAPIFixtures.Sandbox.consumptionRequests.length;
  r = await req(CP, "/v1/apple/webhook", { body: { signedPayload: consumptionPayload } });
  check(
    "同一 CONSUMPTION_REQUEST webhook 重放不重复调用 Apple",
    r.status === 200 &&
      appleAPIFixtures.Sandbox.consumptionRequests.length ===
        consumptionCountAfterFirstResponse,
  );

  appleAPIFixtures.Sandbox.notifications = [{ signedPayload: consumptionPayload }];
  r = await req(CP, "/v1/admin/apple/reconcile", {
    body: { environment: "Sandbox" },
    bearer: ADMIN,
  });
  check(
    "Notification History 重放已响应的消费请求 → 幂等跳过且不报错",
    r.status === 200 &&
      r.json.environments.Sandbox.history.processed === 1 &&
      r.json.environments.Sandbox.history.rejected === 0 &&
      appleAPIFixtures.Sandbox.consumptionRequests.length ===
        consumptionCountAfterFirstResponse,
    JSON.stringify(r.json),
  );
  appleAPIFixtures.Sandbox.notifications = [];

  await stopServer();
  await startServer();
  r = await req(CP, "/v1/apple/webhook", { body: { signedPayload: consumptionPayload } });
  check(
    "控制面重启后消费响应幂等记录仍有效",
    r.status === 200 &&
      appleAPIFixtures.Sandbox.consumptionRequests.length ===
        consumptionCountAfterFirstResponse,
  );

  const secondConsumptionPayload = signAppleJWS({
    notificationType: "CONSUMPTION_REQUEST",
    notificationUUID: crypto.randomUUID(),
    signedDate: Date.now(),
    data: {
      bundleId: "SyengUp.FridayNext",
      environment: "Sandbox",
      consumptionRequestReason: "OTHER",
      signedTransactionInfo: activeJWS,
    },
  });
  r = await req(CP, "/v1/apple/webhook", {
    body: { signedPayload: secondConsumptionPayload },
  });
  check(
    "同一交易的新退款通知 UUID 仍会正常响应",
    r.status === 200 &&
      appleAPIFixtures.Sandbox.consumptionRequests.length ===
        consumptionCountAfterFirstResponse + 1,
  );

  const concurrentConsumptionPayload = signAppleJWS({
    notificationType: "CONSUMPTION_REQUEST",
    notificationUUID: crypto.randomUUID(),
    signedDate: Date.now(),
    data: {
      bundleId: "SyengUp.FridayNext",
      environment: "Sandbox",
      consumptionRequestReason: "OTHER",
      signedTransactionInfo: activeJWS,
    },
  });
  const consumptionCountBeforeConcurrentReplay =
    appleAPIFixtures.Sandbox.consumptionRequests.length;
  const concurrentResponses = await Promise.all([
    req(CP, "/v1/apple/webhook", {
      body: { signedPayload: concurrentConsumptionPayload },
    }),
    req(CP, "/v1/apple/webhook", {
      body: { signedPayload: concurrentConsumptionPayload },
    }),
  ]);
  check(
    "同一消费通知并发到达也只调用 Apple 一次",
    concurrentResponses.every((response) => response.status === 200) &&
      appleAPIFixtures.Sandbox.consumptionRequests.length ===
        consumptionCountBeforeConcurrentReplay + 1,
  );

  console.log("— Production 自动退款建议策略 —");
  const NO_ACTIVATION_USER = "00000000-0000-4000-8000-000000000010";
  const noActivationTransaction = {
    ...transactionBase,
    appAccountToken: NO_ACTIVATION_USER,
    transactionId: "49001",
    originalTransactionId: "49000",
    signedDate: Date.now() + 20,
    environment: "Production",
  };
  r = await req(CP, "/v1/apple/webhook", {
    body: {
      signedPayload: signAppleJWS({
        notificationType: "CONSUMPTION_REQUEST",
        notificationUUID: crypto.randomUUID(),
        signedDate: Date.now(),
        data: {
          bundleId: "SyengUp.FridayNext",
          environment: "Production",
          consumptionRequestReason: "UNINTENDED_PURCHASE",
          signedTransactionInfo: signAppleJWS(noActivationTransaction),
        },
      }),
    },
  });
  check(
    "Production 从未启用 Tunnel → 建议全额退款",
    r.status === 200 &&
      appleAPIFixtures.Production.consumptionRequests.some(
        (item) =>
          item.transactionId === "49001" &&
          item.body.deliveryStatus === "DELIVERED" &&
          item.body.refundPreference === "GRANT_FULL",
      ),
  );

  const activatedProductionTransaction = {
    ...transactionBase,
    transactionId: "49101",
    originalTransactionId: "49100",
    signedDate: Date.now() + 21,
    environment: "Production",
  };
  r = await req(CP, "/v1/apple/webhook", {
    body: {
      signedPayload: signAppleJWS({
        notificationType: "CONSUMPTION_REQUEST",
        notificationUUID: crypto.randomUUID(),
        signedDate: Date.now(),
        data: {
          bundleId: "SyengUp.FridayNext",
          environment: "Production",
          consumptionRequestReason: "UNSATISFIED_WITH_PURCHASE",
          signedTransactionInfo: signAppleJWS(activatedProductionTransaction),
        },
      }),
    },
  });
  check(
    "Production 已正常启用且无退款历史 → 向 Apple 保持中立",
    r.status === 200 &&
      appleAPIFixtures.Production.consumptionRequests.some(
        (item) =>
          item.transactionId === "49101" &&
          item.body.deliveryStatus === "DELIVERED" &&
          Object.hasOwn(item.body, "refundPreference") === false,
      ),
  );

  const approvedRefundPayloads = ["49201", "49301"].map((transactionId, index) =>
    signAppleJWS({
      notificationType: "REFUND",
      notificationUUID: crypto.randomUUID(),
      signedDate: Date.now() + index,
      data: {
        bundleId: "SyengUp.FridayNext",
        environment: "Production",
        signedTransactionInfo: signAppleJWS({
          ...transactionBase,
          transactionId,
          originalTransactionId: `${Number(transactionId) - 1}`,
          signedDate: Date.now() + 30 + index,
          revocationDate: Date.now(),
          environment: "Production",
        }),
      },
    }),
  );
  await req(CP, "/v1/apple/webhook", {
    body: { signedPayload: approvedRefundPayloads[0] },
  });
  await req(CP, "/v1/apple/webhook", {
    body: { signedPayload: approvedRefundPayloads[0] },
  });
  await req(CP, "/v1/apple/webhook", {
    body: { signedPayload: approvedRefundPayloads[1] },
  });
  r = await req(CP, "/v1/admin/state", { method: "GET", bearer: ADMIN });
  check(
    "Production 退款历史按 transactionId 幂等记录",
    r.json.appleRefundHistory[APPLE_USER].approvedTransactionIds.length === 2,
  );

  const declinedRefundPayload = signAppleJWS({
    notificationType: "REFUND_DECLINED",
    notificationUUID: crypto.randomUUID(),
    signedDate: Date.now(),
    data: {
      bundleId: "SyengUp.FridayNext",
      environment: "Production",
      signedTransactionInfo: signAppleJWS({
        ...transactionBase,
        transactionId: "49351",
        originalTransactionId: "49350",
        signedDate: Date.now() + 35,
        environment: "Production",
      }),
    },
  });
  await req(CP, "/v1/apple/webhook", {
    body: { signedPayload: declinedRefundPayload },
  });
  r = await req(CP, "/v1/admin/state", { method: "GET", bearer: ADMIN });
  check(
    "Apple 拒绝退款结果单独留痕且不计入已退款次数",
    r.json.appleRefundHistory[APPLE_USER].approvedTransactionIds.length === 2 &&
      r.json.appleRefundHistory[APPLE_USER].declinedTransactionIds.length === 1,
  );

  const repeatedRefundTransaction = {
    ...transactionBase,
    transactionId: "49401",
    originalTransactionId: "49400",
    signedDate: Date.now() + 40,
    environment: "Production",
  };
  r = await req(CP, "/v1/apple/webhook", {
    body: {
      signedPayload: signAppleJWS({
        notificationType: "CONSUMPTION_REQUEST",
        notificationUUID: crypto.randomUUID(),
        signedDate: Date.now(),
        data: {
          bundleId: "SyengUp.FridayNext",
          environment: "Production",
          consumptionRequestReason: "OTHER",
          signedTransactionInfo: signAppleJWS(repeatedRefundTransaction),
        },
      }),
    },
  });
  check(
    "Production 已启用且已有两次退款 → 建议拒绝重复退款",
    r.status === 200 &&
      appleAPIFixtures.Production.consumptionRequests.some(
        (item) =>
          item.transactionId === "49401" &&
          item.body.refundPreference === "DECLINE",
      ),
  );

  await req(CP, "/v1/admin/killswitch", {
    body: { on: true },
    bearer: ADMIN,
  });
  const outageTransaction = {
    ...transactionBase,
    transactionId: "49501",
    originalTransactionId: "49500",
    signedDate: Date.now() + 50,
    environment: "Production",
  };
  r = await req(CP, "/v1/apple/webhook", {
    body: {
      signedPayload: signAppleJWS({
        notificationType: "CONSUMPTION_REQUEST",
        notificationUUID: crypto.randomUUID(),
        signedDate: Date.now(),
        data: {
          bundleId: "SyengUp.FridayNext",
          environment: "Production",
          consumptionRequestReason: "FULFILLMENT_ISSUE",
          signedTransactionInfo: signAppleJWS(outageTransaction),
        },
      }),
    },
  });
  check(
    "服务故障期间 → 明确标记未交付并建议全额退款",
    r.status === 200 &&
      appleAPIFixtures.Production.consumptionRequests.some(
        (item) =>
          item.transactionId === "49501" &&
          item.body.deliveryStatus === "UNDELIVERED_SERVER_OUTAGE" &&
          item.body.refundPreference === "GRANT_FULL" &&
          item.body.consumptionPercentage === undefined,
      ),
  );
  await req(CP, "/v1/admin/killswitch", {
    body: { on: false },
    bearer: ADMIN,
  });

  const failedConsumptionTransaction = {
    ...transactionBase,
    appAccountToken: NO_ACTIVATION_USER,
    transactionId: "49999",
    originalTransactionId: "49998",
    signedDate: Date.now() + 60,
    environment: "Production",
  };
  r = await req(CP, "/v1/apple/webhook", {
    body: {
      signedPayload: signAppleJWS({
        notificationType: "CONSUMPTION_REQUEST",
        notificationUUID: crypto.randomUUID(),
        signedDate: Date.now(),
        data: {
          bundleId: "SyengUp.FridayNext",
          environment: "Production",
          consumptionRequestReason: "OTHER",
          signedTransactionInfo: signAppleJWS(failedConsumptionTransaction),
        },
      }),
    },
  });
  check("Apple 消费信息接口异常 → 502 促使通知重试", r.status === 502);

  const refundTransaction = signAppleJWS({
    ...transactionBase,
    signedDate: transactionBase.signedDate + 1,
    revocationDate: Date.now(),
  });
  const signedPayload = signAppleJWS({
    notificationType: "REFUND",
    notificationUUID: crypto.randomUUID(),
    signedDate: Date.now(),
    data: {
      bundleId: "SyengUp.FridayNext",
      environment: "Sandbox",
      signedTransactionInfo: refundTransaction,
    },
  });
  r = await req(CP, "/v1/apple/webhook", { body: { signedPayload } });
  check("ASSN v2 双层 JWS webhook 无 bearer验真", r.status === 200 && r.json.ok === true);
  r = await req(CP, "/v1/subscriptions/verify", { body: { appAccountToken: APPLE_USER } });
  check(
    "退款后 → refunded 不再 entitled",
    r.json.state === "refunded" && r.json.entitled === false,
  );
  r = await req(CP, "/v1/admin/state", { method: "GET", bearer: ADMIN });
  check(
    "退款账户的 grant 已撤",
    Object.values(r.json.grants).every((g) => g.appAccountToken !== APPLE_USER),
  );
  r = await req(CP, "/v1/apple/transactions/verify", {
    body: { signedTransaction: activeJWS, appAccountToken: APPLE_USER },
  });
  check("旧交易重放不能覆盖退款", r.status === 200 && r.json.state === "refunded");

  console.log("— App Store Server API 主动对账 —");
  const RECONCILE_USER = "00000000-0000-4000-8000-000000000008";
  const reconcileTransactionBase = {
    ...transactionBase,
    appAccountToken: RECONCILE_USER,
    transactionId: "48001",
    originalTransactionId: "48000",
    signedDate: Date.now() + 10,
  };
  r = await req(CP, "/v1/apple/transactions/verify", {
    body: {
      signedTransaction: signAppleJWS(reconcileTransactionBase),
      appAccountToken: RECONCILE_USER,
    },
  });
  check("主动对账前交易为 active", r.status === 200 && r.json.state === "active");
  const reconcileKey = "6".repeat(64);
  const reconcileAlloc = await req(ALLOC, "/allocate", {
    body: { key: reconcileKey },
    bearer: TOKEN,
  });
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gw-reconcile",
      appAccountToken: RECONCILE_USER,
      deviceId: DEV,
      subdomain: reconcileAlloc.json.subdomain,
      gatewayKey: reconcileKey,
    },
  });
  check("主动对账前已有 live grant", r.status === 200 && typeof r.json.grantId === "string");

  const reconciledRefundTransaction = signAppleJWS({
    ...reconcileTransactionBase,
    signedDate: reconcileTransactionBase.signedDate + 1,
    revocationDate: Date.now(),
  });
  appleAPIFixtures.Sandbox.notifications = [
    {
      signedPayload: signAppleJWS({
        notificationType: "REFUND",
        notificationUUID: crypto.randomUUID(),
        signedDate: Date.now(),
        data: {
          bundleId: "SyengUp.FridayNext",
          environment: "Sandbox",
          signedTransactionInfo: reconciledRefundTransaction,
        },
      }),
    },
  ];
  appleAPIFixtures.Sandbox.statuses.set("48000", {
    bundleId: "SyengUp.FridayNext",
    environment: "Sandbox",
    data: [
      {
        subscriptionGroupIdentifier: "test-group",
        lastTransactions: [
          {
            originalTransactionId: "48000",
            status: 2,
            signedTransactionInfo: reconciledRefundTransaction,
            signedRenewalInfo: "unused",
          },
        ],
      },
    ],
  });
  r = await req(CP, "/v1/admin/apple/reconcile", {
    body: { environment: "Sandbox" },
    bearer: ADMIN,
  });
  check(
    "通知历史补偿 + 当前状态对账均执行",
    r.status === 200 &&
      r.json.environments.Sandbox.history.processed === 1 &&
      r.json.environments.Sandbox.currentStatuses.applied >= 1,
    JSON.stringify(r.json),
  );
  r = await req(CP, "/v1/subscriptions/verify", { body: { appAccountToken: RECONCILE_USER } });
  check("漏通知退款经主动对账 → refunded", r.json.state === "refunded" && !r.json.entitled);
  r = await req(CP, "/v1/admin/state", { method: "GET", bearer: ADMIN });
  check(
    "主动对账退款同步撤销 live grant",
    Object.values(r.json.grants).every((g) => g.appAccountToken !== RECONCILE_USER),
  );

  for (const environment of ["Sandbox", "Production"]) {
    r = await req(CP, "/v1/admin/apple/test-notification", {
      body: { environment },
      bearer: ADMIN,
    });
    check(
      `${environment} TEST 通知请求`,
      r.status === 200 && r.json.testNotificationToken === `${environment}-test-token`,
    );
    r = await req(CP, "/v1/admin/apple/test-notification-status", {
      body: { environment, testNotificationToken: `${environment}-test-token` },
      bearer: ADMIN,
    });
    check(
      `${environment} TEST 通知状态可核验`,
      r.status === 200 && r.json.sendAttempts?.[0]?.sendAttemptResult === "SUCCESS",
    );
  }
  appleAPIFixtures.Sandbox.notifications = [];

  console.log("— frps 闸门联动 —");
  const gateReq = (content) =>
    req(GATE, "/handler", { body: { version: "0.1.0", op: "NewProxy", content } });
  r = await gateReq({ proxy_name: "p1", proxy_type: "https", subdomain: SUB });
  check(
    "已分配子域 → 放行+带宽注入",
    r.json.reject === false &&
      r.json.content.bandwidth_limit === "4MB" &&
      r.json.content.bandwidth_limit_mode === "server",
  );
  r = await gateReq({ proxy_name: "p2", proxy_type: "https", subdomain: "fnhacker0000" });
  check("未分配子域 → 拒绝", r.json.reject === true);
  r = await gateReq({ proxy_name: "mac_ssh", proxy_type: "tcp", remote_port: 6022 });
  check("个人 tcp 隧道(无 subdomain)原样放行", r.json.reject === false && r.json.unchange === true);
  // 吊销
  r = await req(CP, "/v1/admin/revoke", { body: { subdomain: SUB }, bearer: ADMIN });
  check("admin revoke ok", r.status === 200 && r.json.revoked.includes(SUB));
  r = await gateReq({ proxy_name: "p1", proxy_type: "https", subdomain: SUB });
  check("吊销后闸门拒绝", r.json.reject === true && /revoked/.test(r.json.reject_reason));
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gw1",
      appAccountToken: U1,
      deviceId: DEV,
      subdomain: SUB,
      gatewayKey: keyForSub.get(SUB),
    },
  });
  check("吊销后 activate → 403", r.status === 403 && r.json.error === "subdomain_revoked");
  r = await req(CP, "/v1/admin/unrevoke", { body: { subdomain: SUB }, bearer: ADMIN });
  check("unrevoke ok", r.status === 200 && !r.json.revoked.includes(SUB));
  // killswitch
  await req(CP, "/v1/admin/killswitch", { body: { on: true }, bearer: ADMIN });
  r = await gateReq({ proxy_name: "p1", proxy_type: "https", subdomain: SUB });
  check("killswitch → FridayNext 命名空间全拒", r.json.reject === true);
  r = await gateReq({ proxy_name: "mac_ssh", proxy_type: "tcp", remote_port: 6022 });
  check("killswitch 下个人隧道仍放行", r.json.reject === false && r.json.unchange === true);
  await req(CP, "/v1/admin/killswitch", { body: { on: false }, bearer: ADMIN });
  r = await gateReq({ proxy_name: "p1", proxy_type: "https", subdomain: SUB });
  check("killswitch 关闭恢复放行", r.json.reject === false);

  console.log("— OSS 附件旁路签名(Phase E)—");
  // 用前面 U1 的 grant 与网关 key 两条腿
  r = await req(CP, "/v1/oss/sign", {
    body: {
      op: "put",
      grantId: GRANT,
      appAccountToken: U1,
      objectId: "blob1",
      size: 500,
      contentType: "application/octet-stream",
    },
  });
  check(
    "app 腿 PUT 签名 ok",
    r.status === 200 &&
      /att\/.+\/blob1/.test(r.json.objectKey) &&
      r.json.url.includes("Signature="),
    JSON.stringify(r.json),
  );
  check("对象键按 subdomain 隔离", r.json.objectKey.startsWith(`att/${SUB}/`));
  check("配额记账回传", r.json.quota && r.json.quota.used === 500 && r.json.quota.cap === 1024);
  r = await req(CP, "/v1/oss/sign", {
    body: { op: "get", grantId: GRANT, appAccountToken: U1, objectId: "blob1" },
  });
  check("app 腿 GET 签名 ok", r.status === 200 && r.json.url.includes("att/"));
  r = await req(CP, "/v1/oss/sign", {
    body: { op: "put", gatewayKey: "a".repeat(64), objectId: "out1", size: 300 },
  });
  check(
    "网关腿(gatewayKey)PUT 签名 ok",
    r.status === 200 && r.json.objectKey === `att/${SUB}/out1`,
  );
  r = await req(CP, "/v1/oss/sign", {
    body: { op: "put", gatewayKey: "9".repeat(64), objectId: "x", size: 1 },
  });
  check(
    "未分配 gatewayKey → 404",
    r.status === 404 && r.json.error === "gateway_not_allocated",
    JSON.stringify(r.json),
  );
  r = await req(CP, "/v1/oss/sign", {
    body: { op: "put", grantId: "nope", appAccountToken: U1, objectId: "x", size: 1 },
  });
  check("坏 grant → 404", r.status === 404 && r.json.error === "grant_not_found");
  r = await req(CP, "/v1/oss/sign", {
    body: { op: "put", grantId: GRANT, appAccountToken: U1, objectId: "big", size: 2000 },
  });
  check(
    "超月配额 → 429 oss_quota_exceeded",
    r.status === 429 && r.json.error === "oss_quota_exceeded" && r.json.cap === 1024,
  );
  r = await req(CP, "/v1/oss/sign", {
    body: { op: "bad", grantId: GRANT, appAccountToken: U1, objectId: "x" },
  });
  check("坏 op → 400", r.status === 400 && r.json.error === "bad_op");

  console.log("— token 拆分(P0-3)—");
  r = await req(CP, "/v1/admin/state", { method: "GET", bearer: TOKEN });
  check("GW_ALLOC_TOKEN 不能访问 admin", r.status === 401);
  r = await req(CP, "/v1/admin/state", { method: "GET", bearer: ADMIN });
  check("ADMIN token 可访问 admin", r.status === 200);
  r = await req(ALLOC, "/allocate", { body: { key: "e".repeat(64) }, bearer: ADMIN });
  check("ADMIN token 不能 allocate（各司其职）", r.status === 401);

  console.log("— 归属证明(P0-4)—");
  const a5 = await req(ALLOC, "/allocate", { body: { key: "f".repeat(64) }, bearer: TOKEN });
  const SUB5 = a5.json.subdomain;
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gwf",
      appAccountToken: "aat-owner-x",
      deviceId: DEV,
      subdomain: SUB5,
    },
  });
  check(
    "首次 claim 缺 gatewayKey → 403",
    r.status === 403 && r.json.error === "subdomain_ownership_required",
  );
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gwf",
      appAccountToken: "aat-owner-x",
      deviceId: DEV,
      subdomain: SUB5,
      gatewayKey: "0".repeat(64),
    },
  });
  check(
    "首次 claim 错 gatewayKey → 403",
    r.status === 403 && r.json.error === "subdomain_ownership_required",
  );
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gwf",
      appAccountToken: "aat-owner-x",
      deviceId: DEV,
      subdomain: SUB5,
      gatewayKey: "f".repeat(64),
    },
  });
  check("首次 claim 正确 gatewayKey → 200", r.status === 200);
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gwf",
      appAccountToken: "aat-owner-x",
      deviceId: DEV,
      subdomain: SUB5,
    },
  });
  check("已拥有后再 activate 无需 gatewayKey", r.status === 200);

  console.log("— D31 按 Apple ID 多子域 —");
  const aD = await req(ALLOC, "/allocate", { body: { key: "1".repeat(64) }, bearer: TOKEN });
  const BASE = aD.json.subdomain; // gateway "1"*64 base subdomain
  const GK = "1".repeat(64);
  // 第一个 Apple ID 复用 base 子域
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gwd",
      appAccountToken: "aat-d1",
      deviceId: DEV,
      subdomain: BASE,
      gatewayKey: GK,
    },
  });
  check(
    "首个 Apple ID 复用 base 子域",
    r.status === 200 && r.json.subdomain === BASE,
    JSON.stringify(r.json),
  );
  // 第二个 Apple ID 同网关 → 独立子域
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gwd",
      appAccountToken: "aat-d2",
      deviceId: DEV,
      subdomain: BASE,
      gatewayKey: GK,
    },
  });
  const SUB_D2 = r.json.subdomain;
  check(
    "第二个 Apple ID 得到独立子域",
    r.status === 200 && /^fn[0-9a-f]{10}$/.test(SUB_D2) && SUB_D2 !== BASE,
    JSON.stringify(r.json),
  );
  // 同一 Apple ID 再 activate → 稳定复用自己的子域
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gwd",
      appAccountToken: "aat-d2",
      deviceId: DEV,
      subdomain: BASE,
      gatewayKey: GK,
    },
  });
  check("同 Apple ID 子域稳定", r.status === 200 && r.json.subdomain === SUB_D2);
  // 网关轮询：拿到两个子域（免费期 ENFORCE 关，全返回）
  r = await req(CP, "/v1/gateway/subdomains", { body: { gatewayKey: GK } });
  check(
    "网关轮询返回自己的子域集",
    r.status === 200 && r.json.subdomains.includes(BASE) && r.json.subdomains.includes(SUB_D2),
    JSON.stringify(r.json),
  );
  check("网关轮询带 subDomainHost", r.json.subDomainHost === "bj.gw.syengup.host");
  r = await req(CP, "/v1/gateway/subdomains", { body: { gatewayKey: "9".repeat(64) } });
  check("未分配 gatewayKey 轮询 → 403", r.status === 403);

  console.log("— 默认待机 + 纯本地远程激活 —");
  const STANDBY_GK = "2".repeat(64);
  const standbyAlloc = await req(ALLOC, "/allocate", {
    body: { key: STANDBY_GK },
    bearer: TOKEN,
  });
  const STANDBY_SUB = standbyAlloc.json.subdomain;
  const STANDBY_PIN = "a".repeat(64);
  r = await req(CP, "/v1/gateway/standby", {
    body: {
      gatewayKey: STANDBY_GK,
      subdomain: STANDBY_SUB,
      publicKeyPin: STANDBY_PIN,
      waitSec: 0,
    },
  });
  check(
    "未授权网关只待机、不返回代理",
    r.status === 200 && r.json.state === "standby" && r.json.subdomains.length === 0,
    JSON.stringify(r.json),
  );
  const standbyRevision = r.json.revision;
  const wakeStartedAt = Date.now();
  const wakeResponse = req(CP, "/v1/gateway/standby", {
    body: {
      gatewayKey: STANDBY_GK,
      subdomain: STANDBY_SUB,
      publicKeyPin: STANDBY_PIN,
      revision: standbyRevision,
      waitSec: 5,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gw-standby",
      appAccountToken: "aat-standby-owner",
      deviceId: DEV,
      gatewayKey: STANDBY_GK,
    },
  });
  check(
    "纯本地配对无需预知 subdomain 即可远程激活",
    r.status === 200 && r.json.subdomain === STANDBY_SUB,
    JSON.stringify(r.json),
  );
  check("激活返回待机登记的 TLS 公钥 pin", r.json.publicKeyPin === STANDBY_PIN);
  r = await wakeResponse;
  check(
    "授权即时唤醒保持式待机并切换 active desired set",
    r.status === 200 &&
      r.json.state === "active" &&
      r.json.subdomains.includes(STANDBY_SUB) &&
      Date.now() - wakeStartedAt < 2_000,
    JSON.stringify(r.json),
  );
  // 第二个 Apple ID 的独立子域也过闸门
  r = await req(GATE, "/handler", {
    body: {
      version: "0.1.0",
      op: "NewProxy",
      content: { proxy_name: "pd2", proxy_type: "https", subdomain: SUB_D2 },
    },
  });
  check(
    "per-Apple-ID 子域过闸门",
    r.json.reject === false && r.json.content.bandwidth_limit === "4MB",
  );

  console.log("— attest nonce(P2-19)—");
  r = await req(CP, "/v1/attest/nonce", { body: {} });
  check(
    "发 nonce ok",
    r.status === 200 && typeof r.json.nonce === "string" && r.json.ttlSec === 300,
  );
  const NONCE = r.json.nonce;
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gwf",
      appAccountToken: "aat-owner-x",
      deviceId: DEV,
      subdomain: SUB5,
      attestNonce: NONCE,
      attestation: { token: "mock-x", kind: "mock" },
    },
  });
  check("带有效 nonce 的 activate 放行(测试期 mock)", r.status === 200);
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gwf",
      appAccountToken: "aat-owner-x",
      deviceId: DEV,
      subdomain: SUB5,
      attestNonce: NONCE,
      attestation: { token: "mock-x", kind: "mock" },
    },
  });
  check("同一 nonce 重放 → 403 stale_nonce", r.status === 403 && r.json.hint === "stale_nonce");

  console.log("— legacy free-test 运维端点不影响 bootstrap —");
  r = await req(CP, "/v1/admin/free-test-clamp", {
    body: { expiresAt: Date.now() - 1000 },
    bearer: ADMIN,
  });
  check("legacy clamp 仍需 ADMIN 且无 bootstrap 副作用", r.status === 200 && r.json.clamped === 0);
  r = await req(CP, "/v1/subscriptions/verify", { body: { appAccountToken: U1 } });
  check("bootstrap 仍 entitled", r.json.state === "bootstrap" && r.json.entitled === true);

  console.log("— 持久化(重启存活)—");
  await stopServer();
  await startServer();
  r = await req(CP, "/v1/subscriptions/verify", { body: { appAccountToken: U1 } });
  check("重启后 bootstrap 还在", r.json.state === "bootstrap" && r.json.entitled === true);
  r = await req(CP, "/v1/grants/renew", { body: { grantId: GRANT } });
  check("重启后 grant 还在可续期", r.status === 200);
  r = await gateReq({ proxy_name: "p1", proxy_type: "https", subdomain: SUB });
  check("重启后闸门放行已分配子域", r.json.reject === false);

  console.log("— 旧 server trial 迁移 —");
  await stopServer();
  const legacyStatePath = join(dataDir, "cp-state.json");
  const legacyState = JSON.parse(readFileSync(legacyStatePath, "utf8"));
  const legacyUser = "00000000-0000-4000-8000-000000000077";
  legacyState.subs[legacyUser] = {
    state: "trial",
    source: "server-trial",
    startedAt: Date.now() - 10 * 86_400_000,
    expiresAt: Date.now() + 20 * 86_400_000,
  };
  writeFileSync(legacyStatePath, JSON.stringify(legacyState, null, 2));
  await startServer();
  r = await req(CP, "/v1/subscriptions/verify", { body: { appAccountToken: legacyUser } });
  check(
    "旧 30 天试用首次读取即压缩为 bootstrap",
    r.json.state === "bootstrap" &&
      r.json.entitled === true &&
      r.json.expiresAt <= Date.now() + 30 * 60_000,
  );
  r = await req(CP, "/v1/admin/state", { method: "GET", bearer: ADMIN });
  check(
    "迁移写入 bootstrapHistory",
    Boolean(r.json.bootstrapHistory?.[legacyUser]),
  );

  console.log("— 正式一次性短时 bootstrap（不可重领）—");
  await stopServer();
  await startServer({
    CP_BOOTSTRAP_ENABLED: "1",
    CP_BOOTSTRAP_TTL_SEC: "1800",
    CP_ENFORCE_GRANTS: "1",
    GW_RELAY_BOOTSTRAP: "1",
  });
  const trialUser = "00000000-0000-4000-8000-000000000088";
  const trialKey = "7".repeat(64);
  const trialAlloc = await req(ALLOC, "/allocate", {
    body: { key: trialKey },
    bearer: TOKEN,
  });
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gw-one-time-trial",
      appAccountToken: trialUser,
      deviceId: DEV,
      subdomain: trialAlloc.json.subdomain,
      gatewayKey: trialKey,
    },
  });
  check(
    "正式态新用户自动获得一次短时 bootstrap",
    r.status === 200 && typeof r.json.grantId === "string",
  );
  r = await req(CP, "/v1/subscriptions/verify", { body: { appAccountToken: trialUser } });
  check(
    "一次性 bootstrap 期限正确",
    r.status === 200 &&
      r.json.state === "bootstrap" &&
      r.json.entitled === true &&
      r.json.expiresAt > Date.now() + 29 * 60_000 &&
      r.json.expiresAt <= Date.now() + 30 * 60_000,
  );

  // Simulate an expired/compacted subscription record. The durable consumed marker must block
  // both expiration-based extension and deletion-based reseeding for the same stable token.
  await stopServer();
  const cpStatePath = join(dataDir, "cp-state.json");
  const oneTimeState = JSON.parse(readFileSync(cpStatePath, "utf8"));
  check(
    "bootstrap 来源正确并写入持久 consumed marker",
    oneTimeState.subs?.[trialUser]?.source === "pairing-bootstrap" &&
      Boolean(oneTimeState.bootstrapHistory?.[trialUser]),
  );
  delete oneTimeState.subs[trialUser];
  for (const [grantId, grant] of Object.entries(oneTimeState.grants)) {
    if (grant.appAccountToken === trialUser) delete oneTimeState.grants[grantId];
  }
  writeFileSync(cpStatePath, JSON.stringify(oneTimeState, null, 2));
  await startServer({
    CP_BOOTSTRAP_ENABLED: "1",
    CP_BOOTSTRAP_TTL_SEC: "1800",
    CP_ENFORCE_GRANTS: "1",
    GW_RELAY_BOOTSTRAP: "1",
  });
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gw-one-time-trial",
      appAccountToken: trialUser,
      deviceId: DEV,
      subdomain: trialAlloc.json.subdomain,
      gatewayKey: trialKey,
    },
  });
  check(
    "删除订阅行后同一用户也不会重领 bootstrap",
    r.status === 402 && r.json.error === "no_entitlement",
  );

  // The bootstrap can be disabled independently for an immediate paid-only posture.
  await stopServer();
  await startServer({
    CP_BOOTSTRAP_ENABLED: "0",
    CP_ENFORCE_GRANTS: "1",
    GW_RELAY_BOOTSTRAP: "0",
  });
  r = await req(CP, "/v1/relay/bootstrap", { method: "GET" });
  check("GW_RELAY_BOOTSTRAP=0 可关闭引导", r.status === 404);

  const unpaidKey = "8".repeat(64);
  const unpaidAlloc = await req(ALLOC, "/allocate", {
    body: { key: unpaidKey },
    bearer: TOKEN,
  });
  const unpaidSub = unpaidAlloc.json.subdomain;
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gw-unpaid",
      appAccountToken: "unpaid-user",
      deviceId: DEV,
      subdomain: unpaidSub,
      gatewayKey: unpaidKey,
    },
  });
  check("正式态未订阅 activate → 402", r.status === 402 && r.json.error === "no_entitlement");
  r = await req(CP, "/v1/gateway/subdomains", { body: { gatewayKey: unpaidKey } });
  check("正式态未订阅网关拿到空子域集", r.status === 200 && r.json.subdomains.length === 0);
  r = await gateReq({ proxy_name: "unpaid", proxy_type: "https", subdomain: unpaidSub });
  check(
    "正式态未订阅 NewProxy 被硬拒绝",
    r.json.reject === true && /no active grant/.test(r.json.reject_reason),
  );
  r = await gateReq({ proxy_name: "still-personal", proxy_type: "tcp", remote_port: 6023 });
  check("正式态仍不影响个人 tcp 隧道", r.json.reject === false && r.json.unchange === true);

  const paidUser = "00000000-0000-4000-8000-000000000099";
  const paidJWS = signAppleJWS({
    bundleId: "SyengUp.FridayNext",
    productId: "SyengUp.FridayNext.Tunnel.yearly",
    appAccountToken: paidUser,
    transactionId: "99001",
    originalTransactionId: "99000",
    expiresDate: Date.now() + 365 * 86400_000,
    signedDate: Date.now(),
    environment: "Sandbox",
  });
  await req(CP, "/v1/apple/transactions/verify", {
    body: { signedTransaction: paidJWS, appAccountToken: paidUser },
  });
  const paidKey = "9".repeat(64);
  const paidAlloc = await req(ALLOC, "/allocate", {
    body: { key: paidKey },
    bearer: TOKEN,
  });
  r = await req(CP, "/v1/tunnels/activate", {
    body: {
      mode: "seamless",
      gatewayId: "gw-paid",
      appAccountToken: paidUser,
      deviceId: DEV,
      subdomain: paidAlloc.json.subdomain,
      gatewayKey: paidKey,
    },
  });
  const paidSub = r.json.subdomain;
  check("正式态有效权益仍可 activate", r.status === 200 && typeof r.json.grantId === "string");
  r = await gateReq({ proxy_name: "paid", proxy_type: "https", subdomain: paidSub });
  check("正式态有效权益 NewProxy 放行", r.json.reject === false);
} finally {
  await stopServer();
  await Promise.all([
    new Promise((resolve) => appleProductionMock.close(resolve)),
    new Promise((resolve) => appleSandboxMock.close(resolve)),
  ]);
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "✅" : "❌"} passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
