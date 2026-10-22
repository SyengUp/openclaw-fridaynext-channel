# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

Guidance for working in this repository (OpenClaw `friday-next` channel plugin).

## Commands

```bash
pnpm build           # Compile TS to dist/ (required before gateway restart)
pnpm package:pack    # 从固定 npm 依赖生成完整离线部署包
pnpm package:registry --pack-destination /tmp/friday-registry # 只携带插件，由 npm 安装依赖
./install.js        # One-click: install deps, build, and configure OpenClaw
pnpm test:unit       # Vitest unit tests (excludes *.e2e.test.ts)
pnpm test:e2e        # Vitest e2e (vitest.e2e.config.ts)
pnpm test            # unit then e2e
pnpm test:smoke      # Live gateway smoke (optional, needs running gateway)
pnpm test:msg-live   # Live message roundtrip (needs running gateway)
pnpm lint            # ESLint (type-aware); baseline is 0 errors / ~241 warnings
pnpm lint:fix        # ESLint with --fix
pnpm format          # Prettier write all files
pnpm format:check    # Prettier check only (CI-friendly)

# Run a single test file
pnpm vitest run src/http/handlers/messages.test.ts
pnpm vitest run --config vitest.e2e.config.ts src/e2e/send-text.e2e.test.ts
```

Both vitest configs auto-detect the OpenClaw dist directory from standard install paths (`/opt/homebrew`, `/usr/local`, nvm). If your OpenClaw is installed elsewhere, set the `OPENCLAW_DIST` env var or update the candidates in both configs.

### 本地验证与安装来源

网关使用单一 npm 安装来源，禁止叠加 `load.paths`／开发链接。工作区构建不会自动更新网关的安装副本。使用完整 tgz 和下述事务脚本部署；安装位置从 SDK 的 `plugins.installedIndex` 权威记录读取，不按目录通配取第一项，也不假定存在旧版平铺 `npm/node_modules` 路径。

`scripts/verify-isolated-v3.mjs` 可用现有官方 SDK 和完整包启动独立 loopback 测试状态；测试加载路径只存在于该临时配置，不写生产配置。

### 一键部署到网关（开发机 → 192.144.160.181:5023 Mac mini SSH）

```bash
./scripts/deploy-gateway.sh --inspect                 # 只读检查 SDK、安装路径和当前健康
./scripts/deploy-gateway.sh --inspect --host HOST --ssh-port PORT # 覆盖 SSH 入口
./scripts/deploy-gateway.sh --verify-only --package /path/plugin.tgz
./scripts/deploy-gateway.sh --package /path/plugin.tgz --sha256 SHA256
./scripts/deploy-gateway.sh --registry-version VERSION --package /path/plugin.tgz # SDK 正式 npm 更新及完整快照回退
./scripts/deploy-gateway.sh --install-archive --package /path/plugin.tgz # SDK 正式安装未发布完整包，来源记录为 archive
./scripts/deploy-gateway.sh --rollback BACKUP_ID      # 完整代码／依赖回滚，保留当前用户数据
python3 scripts/test_gateway_deployment.py            # 故障台架，不连接生产
```

拓扑：2026-10-21 起按用户指定，Mac mini 默认 SSH 入口为 `syengup@192.144.160.181`、端口 `5023`，部署工具支持 `--host`／`--ssh-port` 或 `GATEWAY_HOST`／`GATEWAY_SSH_PORT` 覆盖。原局域网入口为 `192.168.1.133`；新入口已与原主机密钥核对。OpenClaw 装在 `/opt/homebrew/lib/node_modules/openclaw`，gateway = launchd `ai.openclaw.gateway`（宿主 HTTP 端口 18789）。完整包内嵌 Kit、其传递依赖及 `qrcode-terminal`，不包含宿主 SDK。脚本先在同宿主 SDK 隔离验证，再停止托管服务并等待原进程退出，备份整个 npm 项目、配置、SDK 状态库和频道数据，替换完整包后启动并核对 canonical 能力和长期身份；失败自动回退代码。备份默认位于 `~/.openclaw-deploy-backups/friday-next/`，数据快照不自动覆盖当前账本。详细命令、限制与恢复说明见 [完整包部署手册](docs/operations/gateway-full-package-deployment.md)。部署与重启仍需用户明确要求，不能通过旧的跳过验证选项绕过关卡。

网关版本约束（2026-10-20 更新）：**网关机为 OpenClaw 2026.10.5、Node 26.4.0；完整包已在该官方 SDK 上隔离验证**。2026.10.5 的 HTTP 绑定早于会话数据库后台准入，测试历史时必须等待实际会话可读。9.5+ 有两处外装插件行为必须知道：

1. **双模块实例**——网关注册 HTTP 路由/事件用一个实例，`tool-discovery` 冷加载（`registerFull` 不调 `setRuntime`）另起一个实例跑插件工具；两者同进程同 realm，但**模块级单例各自一份**。所以插件内跨实例必须一致的运行时状态一律走 `globalThis[Symbol.for(...)]` 共享（见 `src/process-state.ts`；`sseEmitter`、v3 store、`friday-session` 映射表、插件运行时存储 `runtime.ts` 均已改）。曾导致 `fridaynext_*` device 工具（位置/健康/日历）误报「iPhone 未连接」。
2. **捕获闭包缺 jiti**——外装插件 tool-discovery 的旧深导入会报 `ERR_MODULE_NOT_FOUND: jiti`（staging 只镜像核心 dist 静态依赖闭包，而 `jiti-factory` 运行时 `moduleResolve("jiti")`）。工具箱目录已改走 gateway-auth 的 `GET /friday-next-admin/tool-catalog?agentId=`（App ≥1.5.2 按插件版本门控）；`/friday-next/agents/{id}/tools/catalog` 仅留给 ≤9.4 的旧 App。

**2026.10.1 破坏性变更（插件 2026.10.1 修复）**：OpenClaw 于 2026-09-30/10-02 提前退休 8 个 SDK 兼容子路径——`channel-lifecycle`、`channel-message`、`channel-reply-pipeline`、`config-runtime`、`infra-runtime`、`command-auth`、`discord`、`telegram-account`。任何**静态 import** 都会以 `ERR_PACKAGE_PATH_NOT_EXPORTED` 让整个插件加载失败（App 全部 `/friday-next/*` 路由消失，doctor 报 `plugin failed during load`）。迁移：`runPassiveAccountLifecycle` 原样迁至 `channel-outbound`（≥6.9 存在，`src/channel-lifecycle-compat.ts` 做新旧宿主动态 import + 本地兜底）；cron 存储读取改用 hook ctx 公开的 `getCron().list()`（`cron-store-runtime` 是宿主私有，不要 import）。`src/sdk-subpath-guard.test.ts` 会扫描源码阻止再引入静态 import。

2026.10.1 另一处**行为破坏**（实测复现）：plain `abortAgentHarnessRun` 不再把 reply operation 标成 `aborted_by_user`，被停的 run 会触发核心 no-visible-reply fallback——App 停止后多出一条「⚠️ OpenClaw couldn't produce or deliver a reply」。修法：`POST /cancel` 走 `abortSessionRunTargetWithOutcome`（core `/stop` 同链路，深导入见 `src/agent/session-abort-bridge.ts`）。回归验证：live 停止（早停/流中停）后无任何 deliver/lifecycle error 帧。

2026.10.5 的标准停止已改为 `prepareSessionRunTargetAbort(params)` 返回提交函数；旧 `abortSessionRunTargetWithOutcome` 不再存在。停止桥须兼容两种形状，并由 `verify-isolated-v3.mjs` 在真实 SDK 上检查可定位、可调用及空闲无副作用，不能把普通 abort 的回退当作该宿主版本的兼容通过。

升级任何 OpenClaw 前仍须备份 `~/.openclaw` 的 DB/state（9.5+ 前向迁移到 schema 21，9.4 拒绝运行）；2026.9.6 备份在网关机 `~/openclaw-backup-pre96-20260924`。

## 公共服务与打包边界

生产标准链路统一使用 `src/adapters/openclaw/channel-service.ts` 创建的 Kit `ChannelService`。原生执行器只提供 SDK 行为；不要把队列、恢复或公共设施周期器重新放回插件。宿主账号持有公共服务租约，旧 App 门面共用同一次公共准入。

Kit 已发布到 npm，生产依赖必须使用精确 registry 版本，禁止恢复 `file:vendor`、link、workspace 或兄弟源码依赖。`pnpm package:registry --pack-destination <目录>` 生成 npm 发布包，包管理器负责安装 Kit。`pnpm package:pack [目录]` 在独立 npm 安装树内嵌全部生产依赖，生成完整离线部署包；pnpm 隔离布局不得直接打包内嵌依赖。npm 发布使用验证过的 registry tgz，部署脚本只接受完整部署 tgz；发布仍需用户明确要求。

已发布版本使用 `--registry-version` 可通过 SDK 官方安装事务维护 npm 来源和版本。该模式的隔离关卡也运行原生 npm 安装，不向 SDK 管理的安装目录手工注入 peer。回滚用 SDK 安装实际代码与提升依赖组成的完整 archive，允许 SDK 代际路径变化，不恢复旧用户数据或手写安装索引。

未发布候选包使用 `--install-archive`：隔离关卡与生产都走 SDK 官方 archive 安装，安装记录如实保存来源与版本；备份和回退共用上述托管事务，不需要先发布 npm。不能与 `--registry-version` 同时使用。

## Architecture

### Data flow

```
iOS App ←--HTTP/SSE--→ Friday Plugin ←--OpenClaw Plugin API--→ Gateway + Agent
                            │
                       [sseEmitter] — broadcasts events to connected devices
                            │
                    [offline-queue] — JSONL per-device persistence for replay
```

1. **`index.ts`** — Plugin entry. Registers HTTP routes, `onAgentEvent` → `forwardAgentEventRaw`, an `llm_output` hook → `accumulateRunUsage` (per-run token usage), tool hooks (`before_tool_call`/`after_tool_call` → `tool-hook` SSE), and a `subagent_delivery_target` hook (routes sub-agent completion responses back to the Friday device that initiated the run). Routes and hooks are re-registered when `registerFull` receives a **new** `api` (compared via a `WeakRef`) so the plugin survives a health-monitor restart; the `onAgentEvent` listener is disposed+re-added each call.
2. **`src/channel.ts`** — Plugin channel definition; `sendText` / `sendMedia` → `sseEmitter.broadcast(..., type: "outbound")` (plus media URL handling via `saveMediaBuffer` / `resolveMediaAttachment`). Its passive HTTP/SSE account uses the SDK `runPassiveAccountLifecycle` so core owns `running`/start/stop/error exactly like long-lived bundled providers; status uses `createComputedAccountStatusAdapter` and never hard-codes lifecycle truth.
3. **`src/http/server.ts`** + **`src/http/handlers/*`** — `/friday-next/*` routes. Full route table:
   - `GET /friday-next/events` — SSE stream (`handleSseStream`)
   - `POST /friday-next/messages` — message dispatch (`handleMessages`)
   - `POST /friday-next/files` — multipart upload (`handleFilesUpload`)
   - `GET /friday-next/files/:id` — file download (`handleFilesDownload`)
   - `POST /friday-next/cancel` — abort a run (`handleCancel`)
   - `POST /friday-next/device-approve` — device trust approval (`handleDeviceApprove`)
   - `POST /friday-next/nodes-approve` — node pairing approval (`handleNodesApprove`); **retained as a legacy-compat service** — current FridayNext iOS builds no longer use the OpenClaw node channel, but un-upgraded clients still pair/dial through it (`install.js` no longer injects node config for fresh installs)
   - `PUT|GET /friday-next/sessions/settings` — read/write session settings (`handleSessionsSettings`)
   - `GET|PUT /friday-next/prompt-capsules` — durable source of truth for the app's prompt capsules (`handlePromptCapsules`), so a delete+reinstall (or a second device) restores them. Global scope (one list per gateway). Stored by `src/prompt-capsules/capsules-store.ts` at `~/.openclaw/friday-next/prompt-capsules/capsules.json` (atomic tmp+rename) as `{version, storeId, revision, updatedAt, capsules[]}`; `storeId` is minted once and never changes. A brand-new store is planted with two starter capsules; an existing file is never re-seeded. PUT replaces the whole list and bumps `revision`; optional `baseRevision` mismatch ⇒ `409` + current state. Introduced in plugin `1.0.16`; the app feature-gates on `pluginVersion`.
   - `GET /friday-next/models` — list available models (`handleModelsList`)
   - `GET /friday-next/agents` — list configured agents (`handleAgentsList`); returns `{ ok, agents, defaultAgentId }` where each agent has `id`/`name`/`description`/`model`/`thinkingDefault`/`isDefault`/`emoji`/`avatar`. Reads `cfg.agents.list` directly from the runtime config (same pattern as models-list, not via gateway dispatch); falls back to a single implicit `main` agent when none are configured.
   - `GET|PUT /friday-next/agents/{id}/config` — read/edit one agent's config (`handleAgentConfig`): `model`/`thinkingDefault`/`tools`/`skills` + discovered `availableSkills`. PUT is a partial patch (explicit `null` clears a field → inherits `agents.defaults`); writes via `api.runtime.config.mutateConfigFile` (`afterWrite: { mode: "auto" }`, in-place draft mutation → hot-reload). Implicit `main` with no list entry gets a bare `{id}` created (never `default: true`).
   - `GET /friday-next/agents/{id}/files` · `GET|PUT /friday-next/agents/{id}/files/{name}` — list/read/write the agent's whitelisted core `.md` workspace files (`handleAgentFiles`): `AGENTS/IDENTITY/SOUL/TOOLS/MEMORY/USER/HEARTBEAT/BOOTSTRAP.md`. Direct fs write into `resolveAgentWorkspaceDir(cfg, id)` (main → workspace root; others → `workspace/agents/{id}`), traversal-guarded, 256 KiB cap, no restart.
   - `GET /friday-next/agents/{id}/tools/catalog` — full tool catalog for the toolbox editor (`handleAgentToolsCatalog`): core + plugin tools grouped by category, with descriptions, the 4 profiles (minimal/coding/messaging/full), and per-tool `enabled`/`inProfile`. Built from core's `buildToolsCatalogResult`.
   - `GET /friday-next/status` — active runs + connection count (`handleStatus`)
   - `GET /friday-next/health` — node-pairing health + optional self-heal (`handleHealth`; query: `deviceId`, `nodeDeviceId`, `selfHeal`); node pair half is optional: the current iOS client omits `nodeDeviceId`/`selfHeal` and decodes without the fields (legacy-compat service for un-upgraded clients)
   - `GET /friday-next/history/sessions` · `GET /friday-next/history/messages` · `PUT|POST /friday-next/sessions/title` · `PUT /friday-next/sessions/pin` — history sync (list sessions across agents, read messages, sync app title → server `displayName`, and update native pin state).
   - `POST /friday-next-admin/sessions/rewind` · `POST /friday-next-admin/sessions/fork` — 消息切点，复用核心 `sessions.rewind/fork`；前者 trusted-operator/admin，后者默认 write，公网均过 App Attest。先拒绝插件未完成/排队任务，并为旧账本补齐不可改写的 `conversationId`。历史读取必须先按 parent/leaf 选活动路径，不能把完整 DAG 当作当前聊天。
   - `GET|PATCH /friday-next-admin/sessions/state` — gateway-authenticated, App-Attest-gated projection/mutation of native session unread state. GET exhausts canonical `sessions.list`; PATCH delegates only `unread` plus optional `agentId`/`expectedSessionId`/`expectedMarkedUnreadAt` guards to `sessions.patch` and stays on the default `operator.write` surface (never `trusted-operator`).
   - `POST /friday-next/sessions/bind` — attach a device to a session's live stream (`src/http/handlers/sessions-bind.ts`): registers the device in the watched-session map (`bindFridayDeviceToSession`, durable in `~/.openclaw/friday-next/session-binds.json`) and injects buffered `agent` frames only for runs without a terminal lifecycle frame (`src/sse/session-replay-buffer.ts`, per-session ring ≤ 400 frames / 60 sessions LRU) into the device's durable SSE queue; completed runs load through transcript history and are never re-presented as live output. From then on `forwardAgentEventRaw` forwards that session's `agent` frames to every bound device — the mechanism by which a conversation started in Control UI / WebChat streams into the iOS app even though the app never POSTed to that session. Additive: a POST-registered owner keeps the owner path; bound devices receive via an extra direct broadcast.
   - `GET /friday-next/link-preview?url=...` — Open Graph metadata for link-preview cards.
   - `GET /friday-next/plugin/info` · `POST /friday-next/plugin/upgrade` — self-version report + in-process npm upgrade & managed-service restart (npm installs only; dev/`--link` installs return 409).
   - `POST /friday-next/device-approve` · `POST /friday-next/nodes-approve` — device/node pairing approval.

   The single registered route (`path: "/friday-next"`, `match: "prefix"`, `auth: "plugin"`) is dispatched by `handleFridayNextRoute` via method+pathname checks; the plugin does its own bearer auth. The `/friday-next/agents/{id}/...` subpaths are parsed segment-wise in `server.ts`.
4. **`src/sse/emitter.ts`** — Singleton `sseEmitter`: connections, per-device monotonic SSE ids, `broadcast` / `broadcastToRun` / `broadcastToolEvent`, integrates **`src/sse/offline-queue.ts`** (JSONL writes before socket write; `connected` events are NOT persisted).
5. **`src/friday-session.ts`** — `deviceId` ↔ `sessionKey` mapping (multiple lookup tables for different key forms); **`forwardAgentEventRaw`** handles:
   - **Thinking delta rewriting** — OpenClaw sends cumulative `data.text` for `stream: "thinking"`; this module computes true incremental `delta` by tracking per-run last-seen text and emitting only the suffix.
   - **Lifecycle metadata merging** — terminal `lifecycle` (`phase: "end"`) frames get `modelName`/`totalTokens`/`contextTokensUsed`/`contextWindowMax` from `run-metadata.ts`.
   - **Terminal lifecycle deferral** — `lifecycle end/error` is deferred briefly so core can persist the run, then the Control UI-equivalent `sessions.list` row is read and merged as `sessionUsage`.
6. **`src/agent/dispatch-bridge.ts`** — `runFridayDispatch` lazy-loads `openclaw/plugin-sdk/reply-dispatch-runtime` via dynamic `import()`. Test mock via `__setMockFridayDispatchForTests`.
7. **`src/agent/active-runs.ts`** — Lifecycle-derived `activeRuns` (tracks `phase: start` / `end` / `error`) for `GET /status`.
8. **`src/agent/subagent-registry.ts`** — Tracks subagent lifecycle (`spawning` → `running` → `ended`). Maintains `childSessionKey` / `runId` → `SubagentEntry` maps. `resolveDeviceIdForRequesterChain` walks the `requesterSessionKey` chain to find the owning device. Supports nested subagents. `forwardAgentEventRaw` queries `lookupByRunId` to annotate subagent `agent` SSE frames with `{ label, parentRunId, depth }`.
9. **`src/config.ts`** + **`src/runtime.ts`** + **`src/host-config.ts`** — Config resolution chain: runtime store → `loadConfig()` → `channels["friday-next"]` with defaults/bounds. Tests inject config via `setMockRuntime`.
10. **`src/run-metadata.ts`** — Per-run in-memory metadata (model name, tokens, context window) extracted from agent events. Also tracks `runId` → `deviceId` routes. In `handleMessages`, if `deliver(kind: "final")` fires before metadata arrives, a **`scheduleLateFinalMetaPatch`** retries up to 6 times (300ms intervals) to emit a `final_meta` outbound SSE when metadata eventually lands.
11. **`src/session/session-manager.ts`** — Session level persistence (`reasoningLevel`/`thinkingLevel`/`modelRef`) in `sessions.json` at `~/.openclaw/agents/main/sessions/sessions.json`. Session key normalization via `toSessionStoreKey`: `"main"` → `"agent:main:main"`, other bare keys get `"agent:main:<key>"` prefix.
12. **`src/agent-forward-runtime.ts`** — Bridges to OpenClaw Agent API (`resolveStorePath`, `loadSessionStore`, `getConfig`) so `forwardAgentEventRaw` can read session store after persist for terminal lifecycle frames.
13. **`src/agent-run-context-bridge.ts`** — Reads agent run context (`sessionKey`) from `Symbol.for("openclaw.agentEvents.state")` global singleton. Used when `onAgentEvent` payload has no `sessionKey` (Control-UI-hidden runs).
14. **`src/session-usage-snapshot.ts` + `src/session-usage-store.ts`** — Builds `FridaySessionUsagePayload` from the Gateway `sessions.list` projection (`totalTokens/contextTokens`), with raw SessionEntry access only as an older-host/Gateway-unavailable fallback.
15. **`src/agent/media-bridge.ts`** — `saveInboundMediaBuffer`: saves attachment buffers via `openclaw/plugin-sdk/media-store` (with tempdir fallback for tests).
16. **`src/http/handlers/files.ts`** — Central file store: `attachments/` directory under plugin root, in-memory index, `storeFile`/`readFile`/`resolveMediaUrl`/`resolveMediaAttachment`. Handles `file://` URI resolution and `~/` expansion for agent-provided paths. The HTTP route handlers are split out: **`files-upload.ts`** (`handleFilesUpload`, multipart `POST`) and **`files-download.ts`** (`handleFilesDownload`, `GET /files/:id`).
17. **`src/agent/run-usage-accumulator.ts`** — Per-`runId` token-usage accumulator fed by the `llm_output` hook (`accumulateRunUsage`). `consumeRunUsage(runId)` drains it into a `FridaySessionUsagePayload` (with `tokens.totalFresh`) for terminal lifecycle frames.
18. **`src/agent/abort-run.ts`** — `abortRunForSessionKey(sessionKey)` backs `POST /cancel`. 首选 **canonical 会话停止**（`src/agent/session-abort-bridge.ts` resilient 深导入 core 的 `abortSessionRunTargetWithOutcome`，即 `/stop` 命令同链路：先把 reply operation 标 `aborted_by_user` → SILENT，再 plain abort 嵌入式 run）；桥不可用（旧核心）回退旧的 `resolveActiveEmbeddedRunSessionId` → `abortAgentHarnessRun` plain abort。2026.10.1 起只做 plain abort 会落进核心 no-visible-reply fallback（App 停止后弹「⚠️ couldn't produce or deliver a reply」），故必须走 canonical 链路。No-op under Vitest（deps 注入测试）。
19. **`src/agent/node-pairing-bridge.ts`** — `loadNodePairingModule` lazy-loads OpenClaw's node-pairing module. Resolves the OpenClaw `dist/` cross-platform: `OPENCLAW_DIST` env → walk `PATH` for the `openclaw` binary → `realpathSync` → `dist/` → platform-standard install paths. Backs `GET /health` and `POST /nodes-approve`.

### Supporting modules

- **`src/channel-actions.ts`** — `describeMessageActions` / `handleMessageAction` for the channel's message-tool integration (`send`, `channel-info`, `channel-list`).
- **`src/friday-inbound-stats.ts`** — Tracks last `POST /messages` timestamp for Control UI channel health display.
- **`src/logging.ts`** — Scoped logger factory (`[friday-next:<scope>]` prefix, level-gated).
- **`src/vendor/runtime-store.ts`** — Vendored from OpenClaw SDK; `Symbol.for("openclaw.plugin-sdk.runtime-store-registry")`-based runtime singleton. Kept here to avoid importing the full gateway graph in tests.
- **`src/openclaw.d.ts`** — Ambient module declarations for `openclaw/plugin-sdk/*` imports (avoids depending on the full SDK type bundle).
- **`src/collect-message-media-paths.ts`** — Extracts local filesystem paths (`/Users/.../file.ext`, `mediaUrl`, `filePath`, `audioPath`) from tool result JSON/strings. Used by outbound media delivery to resolve agent-generated files.
- **`openclaw.plugin.json`** — Plugin manifest declaring channel metadata, `channelConfigs` schema, and UI hints. Env-only configured-state (`FRIDAY_NEXT_AUTH_TOKEN`) lives in `package.json#openclaw.channel.configuredState`, not the legacy `channelEnvVars` field.

### Agent config editing (`/friday-next/agents/{id}/…`)

Lets the app edit a single agent the way ControlUI does — model / core files / tool permissions / skills — entirely through the plugin's own config + workspace access, **zero OpenClaw core changes** (config edits land in `agents.list[]` via `mutateConfigFile`; files write straight to the workspace).

- **`src/agent-id.ts`** — shared `normalizeAgentId` (mirrors core's session-key agent-id rule); used by `agents-list`, the config/files/tools handlers, and discovery. Empty → `main`.
- **`src/http/handlers/agent-config.ts`** — `GET|PUT …/config`. Reads the `agents.list[]` entry; PUT applies a partial patch (null = delete key). Writes go through `getUpgradeRuntime().mutateConfigFile`.
- **`src/http/handlers/agent-files.ts`** — `GET|PUT …/files[/{name}]`. Whitelisted core `.md` files via `resolveAgentWorkspaceDir` + Node fs.
- **`src/skills-discovery.ts`** — `discoverAvailableSkills(cfg, agentId)` returns `{ id, source, description }[]` by **scanning the same dirs core scans** (core's skill-discovery is only in hash chunks, not a stable plugin-sdk export — but skills are directory data, so we scan instead of deep-import). Sources: `workspace` (agent + shared default-agent `skills/`), `installed` (`<configDir>/skills`), `extra` (enabled-extension `dist/extensions/<ext>/skills` + `skills.load.extraDirs`), `built-in` (`<openclaw>/skills`). id = `SKILL.md` frontmatter `name` (recursive). Extension skills gated by `enabledExtensionNames` (= `plugins.allow` ∪ `entries.enabled`) to match ControlUI. Also exports `resolveOpenClawRoot` (shared with tool-catalog).
- **`src/tool-catalog.ts`** + **`src/http/handlers/agent-tools-catalog.ts`** — `GET …/tools/catalog`. The tool catalog is **code, not scannable data**, so this **resilient-deep-imports** core's `buildToolsCatalogResult` (scan `<openclaw>/dist/*.js` for the chunk defining it → dynamic `import()` hits the gateway's already-loaded module instance, no side effects → cache; degrade to 503 on failure). Per-tool `enabled`/`inProfile` are resolved here from the agent's `tools` config so the app renders simple toggles and computes the allow/deny delta.

## SSE event names

`connected` | `agent` | `deliver` | `tool-hook` | `outbound` | `ping` | `subagent` | `inbox-changed`

`subagent` events carry `phase: "spawning"|"spawned"|"ended"` with `runId`, `parentRunId`, `label`, `depth`, `deviceId` for subagent lifecycle UI.

Do not reintroduce `run-start` / `run-complete` / `run-error` / `final` / `reasoning` / `block` / `attachment` / `tts` as top-level SSE events.

## Message flow (`POST /messages`)

Validate auth → `ensureSessionLevels` / session mapping → `runFridayDispatch` with `deliver` → `deliver` SSE (+ URL translation + `channelData.fridayNext` metadata); errors → `outbound` `dispatch_error`. No plugin-side conversation history.

The dispatch context follows the same durable inbound-routing contract as bundled channels such as Telegram: `OriginatingChannel: "friday-next"`, `OriginatingTo: <deviceId>`, `Surface: "friday-next"`, and `AccountId: "default"`. OpenClaw persists these as `deliveryContext` plus `lastChannel`/`lastTo`; proactive-delivery and notification-binding tools require the complete channel+target pair.

`ensureSessionLevels` writes `reasoningLevel` and `thinkingLevel` into `~/.openclaw/agents/main/sessions/sessions.json` keyed by the normalized session key (`"agent:main:<raw>"`).

When `deliver(kind: "final")` fires before model/token metadata has arrived via agent events, the handler falls back to `resolveRunMetadataFromRuntimeSession` (reads recent assistant messages from the session store), and if that also fails, schedules `scheduleLateFinalMetaPatch` (polling retry up to ~1.8s).

## Tool hook flow

`before_tool_call` / `after_tool_call` → `shouldForwardToolEventToFriday` (checks runId→deviceId mapping, then sessionKey→deviceId, then `isFridaySessionKey` pattern match) → `deviceIdFromToolContext` (runId → sessionKey → sole connected device → last registered) → `broadcastToolEvent(type: "tool-hook", ...)` sent only to the owning device. Each hook fires a `console.error` log line prefixed `[Friday-HOOK]` for debugging.

## `subagent_delivery_target` hook

When a sub-agent run completes and `expectsCompletionMessage` is true, this hook checks if the requester origin channel is `friday-next` and resolves the device ID from the requester's session key. Returns an `origin` descriptor so OpenClaw routes the sub-agent's completion message back to the correct Friday device.

## Health & node pairing (`GET /health`, `POST /nodes-approve`)

**Scope note:** the node pairing surface is a **legacy-compat service** retained for un-upgraded FridayNext clients (their chat over HTTP/SSE keeps working, and they still dial the node WebSocket). Current clients never send `nodeDeviceId`/`selfHeal` and ignore the `nodePairing` fields; `install.js` no longer injects node configuration for fresh installs. Do not remove this surface while un-upgraded clients are supported.

`handleHealth` checks node-pairing state for the given `deviceId`/`nodeDeviceId` against `REQUIRED_NODE_CAPS` (`location`, `canvas`) and `REQUIRED_NODE_COMMANDS` (location + canvas command set). With `selfHeal=true` it attempts repair actions (e.g. auto-approving a pending node) and reports each as a `RepairAction`. `handleNodesApprove` approves a pending node pairing request (scope-gated, returns `forbidden` with `missingScope` if not permitted). Both go through `node-pairing-bridge.ts`.

## Config (`src/config.ts`)

From `channels["friday-next"]`: `authToken`, `historyDir` (default `~/.openclaw/friday-next/history`), `sse.backlogPerDevice`, `sse.keepaliveSec`, CORS fields. Offline queue dir: `dirname(historyDir) + "/events-queue"`. Auth token resolution order: `gateway.auth.token` → `channels["friday-next"].authToken` → `FRIDAY_NEXT_AUTH_TOKEN` env var.

### Owner-only tools (`nodes`) from Friday App

Current FridayNext clients never call the OpenClaw `nodes` tool (they use `fridaynext_*` plugin tools over SSE/HTTP instead); `nodes`/`canvas` remain visible only for un-upgraded clients. OpenClaw filters `nodes` by **profile** and **owner**. To verify or fix visibility for those:

1. If using `tools.profile: "coding"` (or similar), add **`tools.alsoAllow: ["nodes", "fridaynext_health_query", "fridaynext_health_log", "fridaynext_location_query"]`** — profile allowlists do not re-include tools removed at profile resolution; `alsoAllow` does. These are plugin tools (SSE + `POST /friday-next/health-query/result` / `POST /friday-next/location/result`); they are **not** `nodes` / `node.invoke`.
2. **Owner:** `POST /friday-next/messages` is Bearer-gated; the plugin sets dispatch **`SenderId`** and **`OwnerAllowFrom: [deviceId]`** (normalized uppercase) so OpenClaw can treat the session as owner when the channel is effectively open (`allowFrom` empty/wildcard) and `commands.ownerAllowFrom` does not override with a fixed list that omits this device.
3. If you use an explicit **`commands.ownerAllowFrom`** list, include the Friday device id there (or use channel `allowFrom`) — context `OwnerAllowFrom` is only used when that config list is empty.

## Tests

- E2E uses **`src/test-support/app-simulator.ts`** (in-process HTTP/SSE harness via `MockReq`/`MockRes`).
- **`setMockRuntime`** (`src/test-support/mock-runtime.ts`) resets emitter + active runs + run metadata + offline queue, creates temp dirs, and injects a fake config object with `loadConfig()`.
- **`MockDispatchScript`** (`src/test-support/mock-dispatch.ts`) is a fluent builder for simulating the dispatch lifecycle: `.lifecycle()`, `.partial()`, `.reasoning()`, `.toolStart()`, `.block()`, `.deliverFinal()`, `.throwError()`. Call `.install()` to replace `runFridayDispatch` with the scripted mock.
- **`src/test-support/mock-dispatch.ts`** also exports standalone `resetMockDispatch()`.

## Important

- Only one global **`sseEmitter`**.
- **`connected`** is not persisted; replay uses **`readAfter(lastEventId)`** on the JSONL file. The `Last-Event-ID` HTTP header and `lastEventId` query param are both supported for reconnect.
- **Device IDs are always normalized to uppercase** (`.toUpperCase()`) before use as map keys, broadcast targets, and in SSE frames.
- Cross-module singleton state uses `Symbol.for()` patterns: `openclaw.plugin-sdk.runtime-store-registry` (runtime store) and `openclaw.agentEvents.state` (agent run context bridge).
- **Session key normalization** (`toSessionStoreKey`): `"main"` maps to `"agent:main:main"`. Other bare keys get `"agent:main:<key>"` prefix. Already-qualified `agent:<id>:<rest>` keys pass through unchanged.
- **Attachments** are persisted under the plugin root `attachments/` directory (`.gitignore`'d) and served at `/friday-next/files/{token}`. The `files.ts` handler maintains an in-memory index that is repopulated from disk on gateway restart via `readAttachmentFileFromDisk`.
- **`openclaw.d.ts`** provides ambient type declarations for all `openclaw/plugin-sdk/*` imports. Tests and build both rely on these rather than installing the full `openclaw` package.
- **Lint policy** (`eslint.config.js`): keep `pnpm lint` at **0 errors**. The ~241 `no-unsafe-*` / `no-explicit-any` **warnings** are structural noise from the untyped OpenClaw host SDK (`openclaw.d.ts` is a hand-written `any` shim) — expected, not debt. `require-await` is off (HTTP handlers / SDK callbacks present async signatures by contract). `_`-prefixed names are intentionally-unused.
