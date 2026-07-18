#!/usr/bin/env node
/**
 * Installer-UI preview — replays the installer's visual sequence with fake timings,
 * so the output can be iterated on without a gateway, an npm install, or a restart.
 *
 *   node scripts/preview-install-ui.mjs            # happy path (default)
 *   node scripts/preview-install-ui.mjs fail       # gateway never comes up
 *   node scripts/preview-install-ui.mjs lan-only   # public access off → LAN pairing
 *   node scripts/preview-install-ui.mjs slow       # slow restart, retrying verify
 *   node scripts/preview-install-ui.mjs all        # every scenario back to back
 *   node scripts/preview-install-ui.mjs ok --fast  # skip the sleeps
 *
 * Prints a real QR from a real FNQR2 pairing envelope, so the code's on-screen size
 * is what a user actually sees.
 */
import { createRequire } from "node:module";
import { createInstallerUI } from "../install-ui.js";

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const FAST = args.includes("--fast");
const scenario = args.find((a) => !a.startsWith("--")) ?? "ok";

const sleep = (ms) => new Promise((r) => setTimeout(r, FAST ? 0 : ms));

// A real FNQR2 envelope (fixture values, never a live gateway's).
const QR_DATA =
  "FNQR2:BwcHBwcHBwcHBwcHILI60bbjVG2vRxDHLhL3LszXrbA6TkJrTjt6h3zkMR553Z678FzOvWwoa3U3brmoPfqbfH30fnawjKLEI2iGIlCggCc_68cAxBrzBmsMiXpqH2MLIk2b";
const LAN_URL = "http://192.168.100.133:8765";
const TOKEN = "b3f1c9d27a4e8051f6c3a9d84b27e105";

function renderQR(data) {
  let out = "";
  require("qrcode-terminal").generate(data, { small: true }, (s) => (out = s));
  return out;
}

async function run(name) {
  const ui = createInstallerUI({ tty: true });
  ui.header(name === "ok" ? "" : `preview: ${name}`);

  const install = ui.step("安装插件");
  await sleep(900);
  install.ok("1.0.15-beta.16 (beta)");

  const configure = ui.step("配置 OpenClaw");
  await sleep(500);
  configure.ok(name === "lan-only" ? "无需改动" : "已更新");

  const restart = ui.step("重启网关");
  restart.detail("20-30 秒");
  await sleep(name === "slow" ? 3000 : 1400);
  restart.ok(name === "slow" ? "较慢，继续校验" : "");

  const verify = ui.step("校验网关");
  if (name === "fail") {
    for (const i of [1, 2, 3]) {
      verify.detail(`重试 ${i}/30`);
      await sleep(600);
    }
    verify.fail("校验超时");
    ui.fatal([
      "网关未就绪，安装未完成",
      "openclaw gateway status",
      "openclaw gateway restart",
      "npx -y @syengup/friday-channel-next",
    ]);
    return;
  }
  if (name === "slow") {
    verify.detail("重试 2/30");
    await sleep(1200);
  } else {
    await sleep(800);
  }
  verify.ok("friday-next 1.0.15-beta.16");

  if (name === "lan-only") ui.note("公网未开启，配对码仅含局域网地址");

  ui.result({ qr: renderQR(QR_DATA), url: LAN_URL, token: TOKEN });
}

const scenarios = scenario === "all" ? ["ok", "lan-only", "slow", "fail"] : [scenario];
for (const s of scenarios) await run(s);
