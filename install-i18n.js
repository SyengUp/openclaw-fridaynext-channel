/**
 * Installer copy, in the user's language.
 *
 * Detection order: `FRIDAY_INSTALL_LANG` (escape hatch / preview) → the POSIX
 * locale env vars → ICU's resolved locale (the only signal on Windows, where
 * `LANG` is usually unset). Anything Chinese gets Chinese; everything else,
 * including `C`/`POSIX`, gets English — a terminal that told us it has no locale
 * is not a terminal to send CJK to.
 *
 * Only two languages on purpose: these strings are four step labels and a handful
 * of failure lines, and every one of them has to stay short enough to sit on one
 * line next to a spinner.
 */

/** @param {NodeJS.ProcessEnv} [env] */
export function detectLang(env = process.env) {
  const forced = (env.FRIDAY_INSTALL_LANG || "").trim().toLowerCase();
  if (forced.startsWith("zh")) return "zh";
  if (forced) return "en";

  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  if (/^(zh|yue)\b|^(zh|yue)[_-]/i.test(locale)) return "zh";
  if (locale && !/^(c|posix)(\.|$)/i.test(locale)) return "en";

  try {
    return /^(zh|yue)\b/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? "zh" : "en";
  } catch {
    return "en";
  }
}

const STRINGS = {
  zh: {
    stepInstall: "安装插件",
    stepConfigure: "配置 OpenClaw",
    stepRestart: "重启网关",
    stepVerify: "校验网关",
    stepTunnel: "等待隧道就绪",

    detailUpdated: "已更新",
    detailUnchanged: "无需改动",
    detailRestartHint: "20-30 秒",
    detailRestartSlow: "较慢，继续校验",
    detailRestartUnconfirmed: "未确认，继续校验",
    detailRestartNoService: "无网关服务（需手动启动）",
    detailRestartSelfStart: "服务未拉起，已直接启动网关",
    detailRetry: (i, n) => `重试 ${i}/${n}`,
    detailTunnelWait: "最长等待 5 分钟",

    scanToPair: "扫描下方二维码完成配对",
    scanFallback: "二维码无法显示，请在 Friday Next 中手动填写",
    labelAddress: "地址",
    labelToken: "令牌",

    noteNoSudo: "无需 sudo 运行",
    noteLanOnly: "FridayTunnel 已停用，配对码仅含本地地址",
    noteTunnelTimeout: "FridayTunnel 准备超时，配对码暂时仅含本地地址；稍后可重新运行",

    failNoNode: "未找到 node",
    failNoNodeHint: "先安装 Node.js",
    failNoOpenclaw: "未找到 openclaw",
    failTooOld: (v) => `OpenClaw ${v} 版本过低，需 2026.5.12 以上`,
    failInstall: "插件安装失败",
    failReadConfig: (p) => `无法读取 ${p}`,
    failReadConfigHint: "确认 OpenClaw 已安装并至少运行过一次",
    failWriteConfig: (p) => `无法写入 ${p}`,
    failGateway: "网关未就绪，安装未完成",
    failGatewayNoService:
      "插件已安装、配置已写入；此环境无网关服务（无 systemd），请先前台启动网关，再重跑本安装完成校验",

    reasonNotOk: "插件返回 ok=false",
    reasonAuth: "令牌不匹配（gateway.auth.token）",
    reasonNotLoaded: "插件未加载（路由 404）",
    reasonTimeout: "校验超时",
  },
  en: {
    stepInstall: "Install plugin",
    stepConfigure: "Configure OpenClaw",
    stepRestart: "Restart gateway",
    stepVerify: "Verify gateway",
    stepTunnel: "Waiting for tunnel",

    detailUpdated: "updated",
    detailUnchanged: "no changes",
    detailRestartHint: "20-30s",
    detailRestartSlow: "slow, verifying",
    detailRestartUnconfirmed: "unconfirmed, verifying",
    detailRestartNoService: "no gateway service (manual start required)",
    detailRestartSelfStart: "service start failed — gateway launched directly",
    detailRetry: (i, n) => `retry ${i}/${n}`,
    detailTunnelWait: "waiting up to 5 min",

    scanToPair: "Scan the code below to pair",
    scanFallback: "QR unavailable — enter these in Friday Next manually",
    labelAddress: "Address",
    labelToken: "Token",

    noteNoSudo: "sudo is not needed",
    noteLanOnly: "FridayTunnel is disabled — QR carries the local address only",
    noteTunnelTimeout:
      "FridayTunnel setup timed out — QR temporarily carries the local address only; rerun later",

    failNoNode: "node not found",
    failNoNodeHint: "install Node.js first",
    failNoOpenclaw: "openclaw not found",
    failTooOld: (v) => `OpenClaw ${v} is too old — 2026.5.12 or newer required`,
    failInstall: "plugin install failed",
    failReadConfig: (p) => `cannot read ${p}`,
    failReadConfigHint: "make sure OpenClaw is installed and has run at least once",
    failWriteConfig: (p) => `cannot write ${p}`,
    failGateway: "gateway not ready — install incomplete",
    failGatewayNoService:
      "plugin installed and configured; no gateway service on this host (no systemd) — start the gateway in the foreground, then re-run this installer to finish verification",

    reasonNotOk: "plugin returned ok=false",
    reasonAuth: "token mismatch (gateway.auth.token)",
    reasonNotLoaded: "plugin not loaded (route 404)",
    reasonTimeout: "verification timed out",
  },
};

/** @param {"zh"|"en"} [lang] */
export function strings(lang = detectLang()) {
  return STRINGS[lang] ?? STRINGS.en;
}
