#!/usr/bin/env node
// 生产控制面(gw-alloc-server.js /v1)本地实证测试。
// 起真实服务进程(临时数据目录+高位端口),打满:契约端点/生产 claim 语义/attest 拒绝/
// 配额/兑换码/webhook 回收/admin 吊销+killswitch→闸门联动/个人隧道零打扰/持久化重启存活。
// 运行:node relay/test-control-plane.mjs   (在插件仓库根,node-app-attest 可解析)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "gw-alloc-server.js");
const ALLOC = 17001, GATE = 17002, CP = 17003;
const TOKEN = "test-bearer-token";
const dataDir = mkdtempSync(join(tmpdir(), "gwalloc-test-"));

let child = null;
function startServer() {
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      GW_ALLOC_DATA_DIR: dataDir,
      GW_ALLOC_PORT: String(ALLOC),
      FRP_GATE_PORT: String(GATE),
      CP_PORT: String(CP),
      GW_ALLOC_TOKEN: TOKEN,
      CP_FREE_TEST: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error("server didn't start: " + out)), 5000);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("control-plane")) { clearTimeout(t); resolve(); }
    });
  });
}
function stopServer() {
  return new Promise((r) => { if (!child) return r(); child.on("exit", r); child.kill(); child = null; });
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
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}

const U1 = "aat-user-1", U2 = "aat-user-2";
const DEV = "device-abc";

try {
  await startServer();
  console.log("— 基础 —");
  let r = await req(CP, "/v1/healthz", { method: "GET" });
  check("healthz", r.status === 200 && r.json.ok === true && r.json.killswitch === false);

  r = await req(ALLOC, "/allocate", { body: { key: "a".repeat(64) } });
  check("allocate 无 bearer 401", r.status === 401);
  r = await req(ALLOC, "/allocate", { body: { key: "a".repeat(64) }, bearer: TOKEN });
  check("allocate ok", r.status === 200 && /^fn[0-9a-f]{10}$/.test(r.json.subdomain));
  const SUB = r.json.subdomain;
  // 幂等
  const r2 = await req(ALLOC, "/allocate", { body: { key: "a".repeat(64) }, bearer: TOKEN });
  check("allocate 幂等", r2.json.subdomain === SUB);

  console.log("— activate(生产 claim 语义)—");
  r = await req(CP, "/v1/tunnels/activate", { body: { mode: "seamless", gatewayId: "gw1", appAccountToken: U1, deviceId: DEV } });
  check("缺 subdomain → 400 subdomain_required", r.status === 400 && r.json.error === "subdomain_required");
  r = await req(CP, "/v1/tunnels/activate", { body: { mode: "seamless", gatewayId: "gw1", appAccountToken: U1, deviceId: DEV, subdomain: "fnnotexist99" } });
  check("未分配 subdomain → 404", r.status === 404 && r.json.error === "subdomain_not_allocated");
  r = await req(CP, "/v1/tunnels/activate", { body: { mode: "seamless", gatewayId: "gw1", appAccountToken: U1, deviceId: DEV, subdomain: SUB } });
  check("claim 已分配子域 → 200", r.status === 200 && r.json.subdomain === SUB, JSON.stringify(r.json));
  check("publicUrl 正确", r.json?.publicUrl === `https://${SUB}.bj.gw.syengup.host`);
  check("grant 签发", typeof r.json?.grantId === "string" && r.json.grantTtlSec === 2592000);
  const GRANT = r.json.grantId, TUNNEL = r.json.tunnelId;
  // FQDN 形式也接受
  r = await req(CP, "/v1/tunnels/activate", { body: { mode: "seamless", gatewayId: "gw1", appAccountToken: U1, deviceId: DEV, subdomain: `${SUB}.bj.gw.syengup.host` } });
  check("FQDN subdomain 归一化 + 隧道复用", r.status === 200 && r.json.tunnelId === TUNNEL);

  console.log("— 免费测试期自动 trial —");
  r = await req(CP, "/v1/subscriptions/verify", { body: { appAccountToken: U1 } });
  check("首次 activate 自动种 trial", r.status === 200 && r.json.state === "trial" && r.json.entitled === true);
  r = await req(CP, "/v1/subscriptions/verify", { body: { appAccountToken: "never-seen" } });
  check("未见过 token → none", r.json.state === "none" && r.json.entitled === false);

  console.log("— attest —");
  r = await req(CP, "/v1/tunnels/activate", { body: { mode: "seamless", gatewayId: "gw1", appAccountToken: U1, deviceId: DEV, subdomain: SUB, attestation: { token: Buffer.from("garbage").toString("base64"), keyId: "k1", kind: "appattest-attest" } } });
  check("伪造 attestation → 403 attest_rejected", r.status === 403 && r.json.error === "attest_rejected", `got ${r.status} ${JSON.stringify(r.json)}`);
  r = await req(CP, "/v1/tunnels/activate", { body: { mode: "seamless", gatewayId: "gw1", appAccountToken: U1, deviceId: DEV, subdomain: SUB, attestation: { token: "mock-x", keyId: null, kind: "mock" } } });
  check("mock attest(测试期)放行", r.status === 200);
  r = await req(CP, "/v1/tunnels/activate", { body: { mode: "seamless", gatewayId: "gw1", appAccountToken: U1, deviceId: DEV, subdomain: SUB, attestation: { token: Buffer.from("garbage").toString("base64"), keyId: "k-unknown", kind: "appattest-assert" } } });
  check("未知 key 的 assertion(测试期)放行+标记", r.status === 200);

  console.log("— 配额(cap=3)—");
  const subs = [SUB];
  for (const k of ["b", "c", "d"]) {
    const a = await req(ALLOC, "/allocate", { body: { key: k.repeat(64) }, bearer: TOKEN });
    subs.push(a.json.subdomain);
  }
  r = await req(CP, "/v1/tunnels/activate", { body: { mode: "seamless", gatewayId: "gw2", appAccountToken: U1, deviceId: DEV, subdomain: subs[1] } });
  check("第2条隧道 ok", r.status === 200);
  r = await req(CP, "/v1/tunnels/activate", { body: { mode: "seamless", gatewayId: "gw3", appAccountToken: U1, deviceId: DEV, subdomain: subs[2] } });
  check("第3条隧道 ok", r.status === 200);
  r = await req(CP, "/v1/tunnels/activate", { body: { mode: "seamless", gatewayId: "gw4", appAccountToken: U1, deviceId: DEV, subdomain: subs[3] } });
  check("第4条 → 409 tunnel_cap_reached", r.status === 409 && r.json.error === "tunnel_cap_reached" && r.json.cap === 3);
  r = await req(CP, "/v1/tunnels/activate", { body: { mode: "seamless", gatewayId: "gwX", appAccountToken: U2, deviceId: DEV, subdomain: subs[3] } });
  check("另一 AppleID claim 同网关不受 U1 配额影响", r.status === 200);

  console.log("— reserve 路径 —");
  r = await req(CP, "/v1/tunnels/reserve", { body: { gatewayId: "gw-rsv" } });
  check("reserve ok", r.status === 200 && r.json.ttlSec === 600 && typeof r.json.reservationId === "string");
  const RSV = r.json.reservationId;
  r = await req(CP, "/v1/tunnels/activate", { body: { reservationId: RSV, appAccountToken: U2, deviceId: DEV, subdomain: subs[3] } });
  check("reservation activate ok", r.status === 200);
  r = await req(CP, "/v1/tunnels/activate", { body: { reservationId: "nope", appAccountToken: U2, deviceId: DEV, subdomain: subs[3] } });
  check("未知 reservation → 404", r.status === 404 && r.json.error === "reservation_not_found");

  console.log("— grant 续期 —");
  r = await req(CP, "/v1/grants/renew", { body: { grantId: GRANT } });
  check("renew ok", r.status === 200 && r.json.expiresAt > Date.now() + 29 * 86400_000);
  r = await req(CP, "/v1/grants/renew", { body: { grantId: "nope" } });
  check("未知 grant → 404", r.status === 404 && r.json.error === "grant_not_found");

  console.log("— 兑换码 —");
  r = await req(CP, "/v1/codes/issue", { body: { code: "GIFT1", days: 365 } });
  check("issue 无 bearer → 401", r.status === 401);
  r = await req(CP, "/v1/codes/issue", { body: { code: "GIFT1", days: 365, maxRedemptions: 1 }, bearer: TOKEN });
  check("issue(admin) ok", r.status === 200 && r.json.code === "GIFT1");
  r = await req(CP, "/v1/codes/redeem", { body: { code: "gift1", appAccountToken: U2 } });
  check("redeem(小写归一) ok", r.status === 200 && r.json.ok === true && r.json.grantedDays === 365);
  r = await req(CP, "/v1/codes/redeem", { body: { code: "GIFT1", appAccountToken: "other" } });
  check("超兑换上限 → 409", r.status === 409 && r.json.error === "code_exhausted");
  r = await req(CP, "/v1/codes/redeem", { body: { code: "NOPE", appAccountToken: U2 } });
  check("无效码 → 404", r.status === 404 && r.json.error === "code_invalid");
  r = await req(CP, "/v1/subscriptions/verify", { body: { appAccountToken: U2 } });
  check("兑换后 → active", r.json.state === "active" && r.json.entitled === true);

  console.log("— webhook 回收 —");
  r = await req(CP, "/v1/apple/webhook", { body: { notificationType: "REFUND", appAccountToken: U2 } });
  check("webhook 无 bearer → 401(F 换 JWS 验签)", r.status === 401);
  r = await req(CP, "/v1/apple/webhook", { body: { notificationType: "REFUND", appAccountToken: U2 }, bearer: TOKEN });
  check("webhook(admin) ok", r.status === 200);
  r = await req(CP, "/v1/subscriptions/verify", { body: { appAccountToken: U2 } });
  check("退款后 → refunded 不再 entitled", r.json.state === "refunded" && r.json.entitled === false);
  r = await req(CP, "/v1/admin/state", { method: "GET", bearer: TOKEN });
  check("U2 的 grant 已撤", Object.values(r.json.grants).every((g) => g.appAccountToken !== U2));

  console.log("— frps 闸门联动 —");
  const gateReq = (content) => req(GATE, "/handler", { body: { version: "0.1.0", op: "NewProxy", content } });
  r = await gateReq({ proxy_name: "p1", proxy_type: "https", subdomain: SUB });
  check("已分配子域 → 放行+带宽注入", r.json.reject === false && r.json.content.bandwidth_limit === "4MB" && r.json.content.bandwidth_limit_mode === "server");
  r = await gateReq({ proxy_name: "p2", proxy_type: "https", subdomain: "fnhacker0000" });
  check("未分配子域 → 拒绝", r.json.reject === true);
  r = await gateReq({ proxy_name: "mac_ssh", proxy_type: "tcp", remote_port: 6022 });
  check("个人 tcp 隧道(无 subdomain)原样放行", r.json.reject === false && r.json.unchange === true);
  // 吊销
  r = await req(CP, "/v1/admin/revoke", { body: { subdomain: SUB }, bearer: TOKEN });
  check("admin revoke ok", r.status === 200 && r.json.revoked.includes(SUB));
  r = await gateReq({ proxy_name: "p1", proxy_type: "https", subdomain: SUB });
  check("吊销后闸门拒绝", r.json.reject === true && /revoked/.test(r.json.reject_reason));
  r = await req(CP, "/v1/tunnels/activate", { body: { mode: "seamless", gatewayId: "gw1", appAccountToken: U1, deviceId: DEV, subdomain: SUB } });
  check("吊销后 activate → 403", r.status === 403 && r.json.error === "subdomain_revoked");
  r = await req(CP, "/v1/admin/unrevoke", { body: { subdomain: SUB }, bearer: TOKEN });
  check("unrevoke ok", r.status === 200 && !r.json.revoked.includes(SUB));
  // killswitch
  await req(CP, "/v1/admin/killswitch", { body: { on: true }, bearer: TOKEN });
  r = await gateReq({ proxy_name: "p1", proxy_type: "https", subdomain: SUB });
  check("killswitch → FridayNext 命名空间全拒", r.json.reject === true);
  r = await gateReq({ proxy_name: "mac_ssh", proxy_type: "tcp", remote_port: 6022 });
  check("killswitch 下个人隧道仍放行", r.json.reject === false && r.json.unchange === true);
  await req(CP, "/v1/admin/killswitch", { body: { on: false }, bearer: TOKEN });
  r = await gateReq({ proxy_name: "p1", proxy_type: "https", subdomain: SUB });
  check("killswitch 关闭恢复放行", r.json.reject === false);

  console.log("— 持久化(重启存活)—");
  await stopServer();
  await startServer();
  r = await req(CP, "/v1/subscriptions/verify", { body: { appAccountToken: U1 } });
  check("重启后订阅态还在", r.json.state === "trial" && r.json.entitled === true);
  r = await req(CP, "/v1/grants/renew", { body: { grantId: GRANT } });
  check("重启后 grant 还在可续期", r.status === 200);
  r = await gateReq({ proxy_name: "p1", proxy_type: "https", subdomain: SUB });
  check("重启后闸门放行已分配子域", r.json.reject === false);
} finally {
  await stopServer();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "✅" : "❌"} passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
