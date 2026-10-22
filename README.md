# FridayNext — an iOS client for OpenClaw

FridayNext is an independent iOS app for OpenClaw. It streams every answer live, shows you
the thinking behind it, and keeps your agent one tap away — anywhere you go.

[<img src="https://raw.githubusercontent.com/SyengUp/openclaw-fridaynext-channel/main/assets/download-on-the-app-store.png" width="120" alt="Download on the App Store">](https://apps.apple.com/us/app/fridaynext/id6768689875)

---

## v3 公共运行边界

生产后端继续只有 OpenClaw。本插件通过固定版本 `@syengup/fridaynext-channel-kit@0.1.3` 的 `ChannelService` 承载完整标准链路和公共设施生命周期；`OpenClawBackendAdapter` 负责 SDK 执行/检查/取消、会话映射、历史与事件转换、控制和专属能力。

标准发送与恢复不再模拟 HTTP 请求调用旧消息处理器。旧 App 门面共用 Kit 的准入、账本与调度；宿主账号生命周期持有 Kit 租约，热加载重入不会重复启动公共服务。配置、技能、定时、Talk、回退/分叉等 OpenClaw 专属实现继续在本仓库保留。架构与验收见 [解耦计划](../Friday/docs/plans/openclaw-decoupling-plan.md)。

新客户端要求明确的 `canonical-v1` 与能力声明；旧客户端保留原输出。公共库已作为公开 npm 包发布，插件通过精确版本依赖 `@syengup/fridaynext-channel-kit: "0.1.3"` 安装，不要求本地 tarball 或兄弟仓库。接口见 [API.md](API.md)。

`pnpm package:registry --pack-destination <目录>` 生成用于 npm 发布的插件包，只携带插件自身，由 npm 安装 Kit 及其他生产依赖。`pnpm package:pack [输出目录]` 从固定 npm 版本生成包含完整依赖的离线部署包，供网关事务脚本使用；两种产物不混用。发布只针对已验证的 registry tgz，且仍需用户单独要求。

开发验证包括 `pnpm test`、`pnpm build`、`pnpm lint`。使用现有官方安装可运行 `OPENCLAW_PACKAGE_ROOT=<官方 OpenClaw 包目录> node scripts/verify-isolated-v3.mjs`；它创建独立 loopback 网关与测试状态，核对官方历史、UUID 绑定、真实 `/help` 执行、幂等及新旧序列化，结束后关闭测试进程。它不调用模型，不连接生产网关。

完整包已在 OpenClaw `2026.10.5`／Node `26.4.0` 上完成隔离验证。网关部署使用 `scripts/deploy-gateway.sh`，包含同宿主预检、完整包替换、私有备份、失败自动回退和显式回滚；操作说明见 [完整包部署手册](docs/operations/gateway-full-package-deployment.md)。部署不发布 npm，且需要用户明确要求。

Kit 发布顺序、registry 插件包与离线部署包的验证入口见 [npm 分发说明](docs/operations/npm-packages.md)。

2026-10-22：Kit 0.1.3 已发布，修复 HEAD 405 被误判为隧道故障而重启 frpc。beta.8 完整包已通过实际 OpenClaw 2026.10.5 验证并仅部署，插件未发 npm；生产观察及用户的连接、模型和侧栏复验通过。固定包、备份与回滚见 [发布部署验收](docs/reviews/tunnel-health-kit-release-2026-10-22.md)。

新附件验收发现的文件正文混入用户气泡已在 OpenClaw 历史适配边界修复，beta.4 按用户授权完成完整包部署，并通过真机复验，本次未发布 npm；真实数据、回滚点与验证见 [文件正文专项](docs/reviews/file-attachment-user-body-2026-10-21.md)。

P5 分叉时的逻辑 UUID 未转换为宿主原生会话已修复，beta.6 完整包通过 1388 unit、43 e2e 及实际 OpenClaw 2026.10.5 的 21 类隔离检查，已按授权仅部署，用户确认分叉／回退及两边历史正常，未发布 npm；真实身份、映射边界、回滚与对账见 [会话动作专项](docs/reviews/session-action-logical-id-2026-10-21.md)。

前台跨会话横幅被已读目录身份错配提前撤销已在 OpenClaw 适配边界修复。beta.7 通过 1392 unit、43 e2e 及实际 SDK 22 类检查，已仅部署、不发布 npm；用户确认横幅稳定、点击跳转与唯一回复正常，详见 [通知身份专项](docs/reviews/foreground-notification-identity-2026-10-21.md)。

OpenClaw 2026.10.5 的标准停止入口兼容、SDK 验证门槛及 beta.3 本地部署结果见 [停止桥修复记录](docs/reviews/openclaw-stop-compatibility-2026-10-21.md)；未发布 npm。真实停止、动画及三次及时停止样本通过，首个约 20 秒的服务端阻塞仍保留 [调查记录](docs/reviews/openclaw-stop-latency-2026-10-21.md)。

## Why FridayNext

**Your agent, not a stranger's.** FridayNext talks to *your own* OpenClaw gateway. Self-hosted
and private by default — your conversations, your data, your rules. No middleman, no lock-in.

**Watch it think.** Answers stream in real time with the agent's reasoning, tool calls, and
subagent work laid out as they happen. You don't just get the result — you see how it got
there, and you can jump in at any moment.

**More than chat.**

| Feature | Why |
| --- | --- |
| 🗣️ **Talk in real time** | Full voice conversations with your agent — speak naturally, and it can run tools and check facts mid-call before answering. |
| 🔊 **Listen to answers** | Built-in text-to-speech reads responses aloud while you're on the move. |
| 📅 **Calendar & Reminders** | Your agent reads your schedule and writes back: "what's today look like?" and "remind me to call the bank Tuesday" become real events and reminders, alarms included. |
| ❤️ **Health, both ways** | Ask about sleep, steps, or caffeine — the agent reads Apple Health, and can log meals, water, caffeine, and body measurements back into it. |
| ⏰ **Scheduled tasks** | Set recurring jobs from your phone and let your agent work on a schedule. |
| 🔔 **Proactive notifications** | Your agent reaches out when something needs you — right in your notification inbox. |
| 📎 **Share anything** | Send links, text, photos, and files to your agent straight from the iOS share sheet. |
| 🌍 **Reach it anywhere** | Optional FridayTunnel relay keeps you connected to your gateway when you're away from home. |
| 🗂️ **Organize your AI** | Multiple agents, multiple servers, per-agent settings, and history that syncs across your devices. |
| 🖼️ **Beautiful by design** | A native iOS experience built for speed and elegance — from the first message to the last. |

Calendar, Reminders, and Health access are agent **tools** (`fridaynext_calendar_query/log`,
`fridaynext_health_query/log`): they run over your own Friday SSE channel to your paired
iPhone, behind separate read and write toggles you control in the app — the phone has to
be online, and nothing is written without the write toggle on.

## A glimpse inside

<p align="center">
  <img src="https://raw.githubusercontent.com/SyengUp/openclaw-fridaynext-channel/main/assets/screenshots/frame-33.png" width="1055" alt="FridayNext screenshots — home, live agent work, calendar integration, agent management, Apple Health, and native markdown">
</p>

<p align="center"><em>Your agents, your chats, your tools — all in one place.</em></p>

## Download

[<img src="https://raw.githubusercontent.com/SyengUp/openclaw-fridaynext-channel/main/assets/download-on-the-app-store.png" width="120" alt="Download on the App Store">](https://apps.apple.com/us/app/fridaynext/id6768689875)

Available now on the App Store for iPhone. Free to download.

---

## What's this package?

`@syengup/friday-channel-next` is the OpenClaw side of FridayNext: a channel plugin that
connects the app to your own OpenClaw gateway. Install it once, pair your iPhone, and your
agent is in your pocket — with your phone acting as an OpenClaw **channel** (chat, voice,
calendar/Health/location tools over HTTP + SSE), so your agent can talk with you by voice,
and read or write your calendar, reminders, Apple Health, and your current location when
you allow it.

```bash
npx -y @syengup/friday-channel-next
```

One command for every platform (macOS, Linux, native Windows) — the installer probes
npmjs.org vs npmmirror itself and installs from the faster one, so it works in mainland
China too.

Then open FridayNext and follow the in-app setup — no command line required after that.

## Links

- **Download the app:** <https://apps.apple.com/us/app/fridaynext/id6768689875>
- **OpenClaw:** <https://openclaw.ai>
- **Plugin source:** <https://github.com/SyengUp/openclaw-fridaynext-channel>

---

*For developers: the plugin's API contract lives in [`API.md`](API.md) and
[`API.zh-CN.md`](API.zh-CN.md).*
