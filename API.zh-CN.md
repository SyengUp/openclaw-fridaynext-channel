# Friday Next HTTP/SSE API（v2 — 透明代理）

插件将 OpenClaw 原生事件透传到 SSE，并按 `deviceId` 将事件持久化到磁盘 JSONL，支持断线重连与进程重启后的 `Last-Event-ID` 回放。

## 鉴权

所有接口都需要：

`Authorization: Bearer <token>`

token 读取优先级：

1. `gateway.auth.token`
2. `channels["friday-next"].authToken`
3. `FRIDAY_NEXT_AUTH_TOKEN`

## SSE

`GET /friday-next/events?deviceId=<deviceId>[&lastEventId=<n>]`

返回头：

- `Content-Type: text/event-stream; charset=utf-8`
- `Cache-Control: no-cache, no-store, must-revalidate`

标准 SSE 帧：

```text
id: 42
event: agent
data: {"runId":"...","seq":1,"ts":...,"stream":"lifecycle","data":{"phase":"start"}}

```

保活：

```text
: keepalive

```

断线重放来源：

- `Last-Event-ID` 请求头
- `lastEventId` 查询参数

重连后服务端会先发新的 `connected`，再按磁盘队列回放 **id 大于** 给定 last id 的事件。

说明：

- `id` 只在同一 `deviceId` 下单调递增。
- 需要 Bearer 的客户端请勿使用无法自定义 Header 的浏览器原生 `EventSource`。

## 事件类型（SSE 的 `event:` 名）

仅下列事件名：

| `event` | 来源 | 说明 |
|--------|------|------|
| `connected` | 插件合成 | 握手：`deviceId`、`serverTime`、`lastSeq` |
| `agent` | OpenClaw `onAgentEvent` | 原生流（`lifecycle` / `assistant` / `tool` / `thinking` / …） |
| `deliver` | 调度 `deliver` | `kind`: `tool` \| `block` \| `final`；`payload` 内媒体 URL 会译为 `/friday-next/files/:id` |
| `tool-hook` | `before_tool_call` / `after_tool_call` | 钩子负载 + `runId`、`deviceId`、`sessionKey` |
| `outbound` | 频道 `sendText` / `sendMedia`、派发错误 | 主动推送或 `op: "dispatch_error"` |
| `ping` | （保留） | — |

**已废弃（破坏性变更）：** 顶层 SSE 事件 `run-start`、`run-complete`、`run-error`、`final`、`reasoning`、`block`、`attachment`、`tts`、以及插件自造的 final 增量等。请统一从 **`agent`**（`stream === "lifecycle"` + `phase`）和 **`deliver`** 推断状态与正文。

### 离线队列

- 默认路径：`<dirname(historyDir)>/events-queue/<DEVICE>.jsonl`（默认 `historyDir` 时约为 `~/.openclaw/friday-next/events-queue/`）。
- `connected` **不落盘**；其余事件 **先 append 再下发**。
- 裁剪：保留最近 `channels["friday-next"].sse.backlogPerDevice` 条（默认 200）。

## 发消息

`POST /friday-next/messages`

```json
{
  "deviceId": "IOS-UUID",
  "text": "你好",
  "sessionKey": "my-session",
  "attachments": ["file-id-1.png"]
}
```

返回 `202`，body：`{ "accepted", "deviceId", "runId" }`。

插件只做 **协议翻译**（附件 → `media://inbound/<id>`、`To` / `OriginatingTo`、命令相关字段），**不在插件端保存对话历史**。`/new`、`/reset` 不会在本地清历史，按普通文本交给 OpenClaw。

## 文件

- `POST /friday-next/files`（`multipart/form-data`：`file`、`deviceId`、可选 `mimeType`）
- `GET /friday-next/files/:id`

## 取消

`POST /friday-next/cancel`，body：`{ "sessionKey", "runId"? }`。`sessionKey` 为主标识（一会话同时至多一个 run）：插件据此解析出 run 内部 `sessionId` 并调用 OpenClaw harness 的 **abort-and-drain**（等待 run 真正结束）。`runId` 为向后兼容回退：缺 `sessionKey` 时经 run route 反解出 sessionKey，并用于 untrack SSE 转发。两者至少给其一（否则 `400`）。返回 `200`，含 `{ ok, sessionKey, runId, aborted, drained }`；**不再**由插件单独发 `run-error`。

## 状态

`GET /friday-next/status`：在英文版基础上增加 `activeRuns`、`activeRunCount`（由 lifecycle 跟踪）。

## Agent 管理

像 OpenClaw ControlUI 一样读取/编辑单个 agent 的配置，但全部经插件自己的配置通道（`api.runtime.config.mutateConfigFile`）落地——**不改 OpenClaw 核心**。配置类改动写入宿主配置文件的 `agents.list[]`；核心 `.md` 文件直接写入 agent 的 workspace 目录。`{id}` 按 OpenClaw 会话键 agent id 规范化（去空白/小写/slug，空 → `main`）。

### GET /friday-next/agents/{id}/config

返回可编辑字段：`exists`（是否存在 `agents.list[]` 条目，`main` 等隐式 agent 可能尚无）、`model`（字符串或 `{primary,fallbacks}`；`undefined`=继承 `agents.defaults`）、`thinkingDefault`、`tools`、`skills`（`undefined`=继承、`[]`=全禁）、`availableSkills`（agent 可加载技能的完整目录，供技能选择器用，每项 `{ id, source, description? }`；`source` 为 `workspace|installed|extra|built-in`，按 id 去重 workspace 优先；`id`/`description` 取自 `SKILL.md` frontmatter 的 `name`/`description`，递归发现；聚合 agent workspace、共享默认 agent workspace、managed 目录(`<configDir>/skills`)、`skills.load.extraDirs` 与 bundled 核心/扩展技能；不含 ClawHub 远端独有技能与可用性标记）。

### PUT /friday-next/agents/{id}/config

局部 patch——只改 body 中出现的键。显式 `null` 表示**清除**该字段（删除以回退 `agents.defaults`）；省略则不动。

```json
{ "model": "openai/gpt-5", "thinkingDefault": "medium", "tools": { "deny": ["bash"] }, "skills": [] }
```

- `model`：字符串、`{primary,fallbacks}`，或 `null`（清除）。
- `skills`：技能 id 数组、`[]`（全禁）、`null`（清除→继承）；非数组且非 null 返回 `400`。
- agent 无 `agents.list[]` 条目时自动创建一条 `{ id }`（绝不标记 `default`）。

返回 `200` 及刷新后的配置视图。写入使用 `afterWrite: { mode: "auto" }`，由网关决定热重载或重启。

### GET /friday-next/agents/{id}/tools/catalog

agent 的完整工具目录(核心 + 插件工具，对齐 ControlUI)，供工具箱编辑器用。由核心 `buildToolsCatalogResult` 构建(弹性深导入，不可用时优雅返回 503)。编辑经 `PUT …/config` 的 `tools` 字段保存。

返回 `{ ok, id, profile, profiles[{id,label}], groups[{id,label,source,pluginId?,tools[{id,label,description,source,enabled,inProfile}]}] }`：

- `profile`=agent 配置的档位(未设为 null)；`profiles`=可选预设(Minimal/Coding/Messaging/Full)。
- `enabled`=该工具在当前 `tools` 配置下的生效态；`inProfile`=当前档位是否默认含它(app 拨动工具时据此算 allow/deny 增量)。
- `groups[].source` 为 `core|plugin`(插件组带 `pluginId`)；插件工具仅纳入已启用插件。

### 核心文件

白名单：`AGENTS.md`、`IDENTITY.md`、`SOUL.md`、`TOOLS.md`、`MEMORY.md`、`USER.md`、`HEARTBEAT.md`、`BOOTSTRAP.md`。直接写入 workspace——不重启，agent 下次运行时重读。

- `GET /friday-next/agents/{id}/files` — 列出每个白名单文件的存在状态与字节数。
- `GET /friday-next/agents/{id}/files/{name}` — 返回单文件内容（不存在则 `exists:false`、`content` 为空）。
- `PUT /friday-next/agents/{id}/files/{name}` — body `{ "content": "..." }`。非白名单或路径穿越名 → `400`；超 256 KiB → `413`。

## 已删除接口

- `GET` / `DELETE /friday-next/history` — 已删除，客户端应用 SSE 自行重建上下文。

---

## 附录：收到 HTML 而不是 SSE？

若响应 `Content-Type` 为 `text/html` 或正文以 `<!doctype html>` 开头，说明请求 **未进入本插件**，被 Gateway 控制界面当作普通页面。

请检查：

1. `channels["friday-next"]` 不能只有 `"enabled": true`；至少增加例如 `"transport": "http+sse"`，并 **重启 Gateway**。
2. 插件入口已启用，日志中出现 `Friday Next channel HTTP routes registered`。
3. URL 精确：`GET /friday-next/events?deviceId=...`，发消息为 `POST /friday-next/messages`。

自测示例：

```bash
curl -sS -D - "http://127.0.0.1:18789/friday-next/events?deviceId=test" \
  -H "Authorization: Bearer <token>" -o /tmp/out --max-time 2
```

成功时应为 `Content-Type: text/event-stream`。
