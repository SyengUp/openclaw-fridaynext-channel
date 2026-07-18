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
 *   node scripts/preview-install-ui.mjs all --lang=en   # force a language (default: yours)
 *
 * Prints a real QR from a real FNQR2 pairing envelope, so the code's on-screen size
 * is what a user actually sees.
 */
import { createRequire } from "node:module";
import { createInstallerUI } from "../install-ui.js";
import { detectLang, strings } from "../install-i18n.js";

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const FAST = args.includes("--fast");
const scenario = args.find((a) => !a.startsWith("--")) ?? "ok";
const langArg = args.find((a) => a.startsWith("--lang="))?.slice("--lang=".length);
const LANG = langArg ? (langArg.startsWith("zh") ? "zh" : "en") : detectLang();
const T = strings(LANG);

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
  ui.header(name === "ok" ? `preview · ${LANG}` : `preview · ${LANG} · ${name}`);

  const install = ui.step(T.stepInstall);
  await sleep(900);
  install.ok("1.0.15-beta.16 (beta)");

  const configure = ui.step(T.stepConfigure);
  await sleep(500);
  configure.ok(name === "lan-only" ? T.detailUnchanged : T.detailUpdated);

  const restart = ui.step(T.stepRestart);
  restart.detail(T.detailRestartHint);
  await sleep(name === "slow" ? 3000 : 1400);
  restart.ok(name === "slow" ? T.detailRestartSlow : "");

  const verify = ui.step(T.stepVerify);
  if (name === "fail") {
    for (const i of [1, 2, 3]) {
      verify.detail(T.detailRetry(i, 30));
      await sleep(600);
    }
    verify.fail(T.reasonTimeout);
    ui.fatal([
      T.failGateway,
      "openclaw gateway status",
      "openclaw gateway restart",
      "npx -y @syengup/friday-channel-next",
    ]);
    return;
  }
  if (name === "slow") {
    verify.detail(T.detailRetry(2, 30));
    await sleep(1200);
  } else {
    await sleep(800);
  }
  verify.ok("friday-next 1.0.15-beta.16");

  if (name === "lan-only") ui.note(T.noteLanOnly);

  ui.result({
    qr: renderQR(QR_DATA),
    fields: [
      { label: T.labelAddress, value: LAN_URL },
      { label: T.labelToken, value: TOKEN },
    ],
  });
}

const scenarios = scenario === "all" ? ["ok", "lan-only", "slow", "fail"] : [scenario];
for (const s of scenarios) await run(s);
