# Friday Channel 插件 API 文档

## 概述

Friday Channel 插件是 OpenClaw 的一个插件，用于桥接 iOS 应用与 OpenClaw Agent 运行时，提供：

- **入站**：iOS App → Agent，通过 HTTP POST 发送消息 + SSE 流式接收响应
- **出站**：Agent → iOS App，通过出站适配器 + SSE 推送消息
- **历史**：每个 session 的对话历史，支持 JSON 文件持久化

所有接口均以 `/friday/` 为前缀，通过 `api.registerHttpRoute()` 注册。

---

## 认证

所有接口均需要在请求头中携带 `Authorization: Bearer <token>`。插件验证 bearer token 必须与 `openclaw.json` 中 `gateway.auth.token` 的值完全一致。不匹配则返回 `401 Unauthorized`。

插件与 gateway 的 WebSocket 连接使用同一个 token——所有请求均使用 gateway 配置的 auth token。

---

## APP 端：收到 HTML 而不是 SSE？

若客户端（URLSession、`EventSource` 等）解析响应时发现 **`Content-Type` 为 `text/html`**，或正文以 **`<!doctype html>`** 开头，**这不是** 认证失败返回的 JSON，而是请求 **没有进入 Friday 插件**，被 OpenClaw **控制界面（SPA）** 当作普通页面返回了。

**请逐项核对：**

1. **`channels.friday` 不能只有 `"enabled": true`**。OpenClaw 在启动 Gateway 时会把「除 `enabled` 外没有其他字段」的频道配置视为**未配置**，从而**不加载** Friday 通道插件，`/friday/*` 会一直落到控制界面 HTML。**至少增加任意一个额外字段**，例如：
   ```json
   "friday": {
     "enabled": true,
     "transport": "http+sse"
   }
   ```
   修改后必须 **重启 Gateway**（或 `openclaw gateway restart`）。
2. **`plugins.entries.friday.enabled`** 已为 `true`，且与上一条同时满足。
3. **SSE URL 必须精确**：`GET /friday/events?deviceId=<你的设备 ID>`（注意是 **`events`**；发消息用 **`POST /friday/messages`**，不是 `/friday/message`）。
4. **主机与端口**与运行 Gateway 的进程一致（默认 `http://<host>:18789`）。
5. Gateway 启动日志中应出现 **`Friday channel HTTP routes registered`**（来自本插件）；若没有，说明路由未注册，客户端永远会落到 HTML。

用 `curl` 自测（将 token 换成你的 `gateway.auth.token`）：

```bash
curl -sS -D - "http://127.0.0.1:18789/friday/events?deviceId=test" \
  -H "Authorization: Bearer <token>" -o /tmp/out --max-time 2
```

成功命中插件时，响应头应包含 **`Content-Type: text/event-stream`**；若为 **`text/html`**，仍按上面清单排查。

---

## 接口：SSE 事件流

### `GET /friday/events`

建立持久 SSE 连接，实时接收 Agent 事件推送。

**请求**

```
GET /friday/events?deviceId=<deviceId>
Authorization: Bearer <token>
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `deviceId` | string | 是 | 设备唯一标识（UUID 或自定义字符串） |

**响应** — `200 OK`，`Content-Type: text/event-stream`

连接建立后首先发送 `connected` 事件，随后实时推送各类型事件。

**SSE 事件格式**

每条事件为纯 JSON 行，以 `\n` 分隔（无 `data:` 前缀）：

```json
{"type":"eventType","phase":"...","...":""}
```

**SSE 事件类型**

| 事件类型 | 说明 | data 字段 |
|----------|------|----------|
| `agent` | 连接状态或运行生命周期 | `{ event: "connected" \| "run-start" \| "message" \| "media", deviceId?, runId?, timestamp }` |
| `reasoning` | 推理流 | `phase: "start" \| "delta" \| "end"`，`{ text?, runId, timestamp }` |
| `tool` | 工具调用生命周期 | `phase: "start" \| "end" \| "error"`，`{ toolName, params?, toolCallId?, error?, text?, durationMs?, runId, deviceId, timestamp }` |
| `final` | 回复正文流 | `phase: "start"` 在首次 `deliver("final")` 或 `onPartialReply` 时注入；正文事件无 `phase` 字段；`done: true`（通过 `notifyRunComplete`）触发 `phase: "end"` |
| `block` | Assistant 代码块/图片块 | `{ text, mediaUrls, isError, runId, deviceId }` |
| `run-complete` | Agent 运行完成 | `{ runId }` |
| `run-error` | Agent 运行出错 | `{ runId, error }` |

**Phase 字段说明**

- `reasoning` 和 `final` 使用统一的 `phase` 字段：`start` → `delta`（×N） → `end`
- `tool` 使用 `phase: "start"` / `"end"` / `"error"`
- `block` 和 `run-complete`/`run-error` 不使用 `phase`

**心跳**：服务端每 30 秒发送一次 `: keepalive\n\n`。

**使用示例**

```bash
curl -N -X GET "http://localhost:18789/friday/events?deviceId=MY-DEVICE" \
  -H "Authorization: Bearer my-token"
```

```json
{"type":"agent","event":"connected","deviceId":"MY-DEVICE","timestamp":1775099965312}
{"type":"agent","event":"run-start","runId":"abc-123","deviceId":"F25427B3-77B4-466B-9CA9-5312649E3978"}
{"type":"reasoning","phase":"start","runId":"abc-123","timestamp":1775099970503}
{"type":"reasoning","phase":"delta","text":"推理：用户问的是一个关于...","runId":"abc-123"}
{"type":"reasoning","phase":"end","runId":"abc-123","timestamp":1775099972000}
{"type":"tool","phase":"start","toolName":"exec","params":{"command":"ls"},"runId":"abc-123","deviceId":"MY-DEVICE","timestamp":1775099972050}
{"type":"tool","phase":"end","toolName":"exec","toolCallId":"call_abc","text":"file1.txt\nfile2.txt","durationMs":42,"runId":"abc-123","deviceId":"MY-DEVICE","timestamp":1775099972100}
{"type":"final","phase":"start","runId":"abc-123","timestamp":1775099973000}
{"type":"final","text":"以下是目录中的文件。","mediaUrls":[],"isError":false,"runId":"abc-123","deviceId":"MY-DEVICE"}
{"type":"final","phase":"end","runId":"abc-123","timestamp":1775099975000}
{"type":"run-complete","runId":"abc-123"}
```

---

## 接口：发送消息

### `POST /friday/messages`

向 Agent 发送用户消息。Agent 异步处理，结果通过 SSE 推送回来。

**请求**

```
POST /friday/messages
Authorization: Bearer <token>
Content-Type: application/json
```

**请求体**

```typescript
interface FridayMessagePayload {
  deviceId: string;           // 必填。设备唯一标识。
  text: string;               // 必填。消息文本。
  sessionKey: string;         // 必填。由 APP 决定；插件原样用于 SessionKey、历史与会话配置（不做改写）。
  attachments?: string[];     // 可选。附件 ID 数组（来自 /friday/files 上传）。
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `deviceId` | string | 是 | 设备标识（非空） |
| `text` | string | 是 | 消息文本（非空） |
| `sessionKey` | string | 是 | 会话标识，**仅由 APP 传入**；插件不修改、不映射 |
| `attachments` | string[] | 否 | 附件 ID 数组（需先通过 `POST /friday/files` 上传） |

**响应** — `202 Accepted`（立即返回，处理异步进行）

```json
{
  "accepted": true,
  "deviceId": "MY-DEVICE"
}
```

**错误响应**

| 状态码 | 条件 |
|--------|------|
| `400 Bad Request` | 缺少或为空 `deviceId`、`text` 或 `sessionKey` |
| `401 Unauthorized` | 缺少或无效 bearer token |

**处理流程**

1. 验证 token 和请求体
2. 立即返回 `202 Accepted`
3. 同步写入 `reasoningLevel: "stream"` + `thinkingLevel: "medium"` 到 `sessions.json`
4. 构建消息体，附件转为 `[media attached: media://inbound/<id>]` 格式
5. 后台创建对话历史 round（最新在前，最多 25 轮）
6. 通过 `dispatchReplyWithDispatcher()` 分发给 Agent
7. 通过 SSE 将事件推送回对应 deviceId 的 SSE 连接
8. 完成时发送 `run-complete` 事件
9. 出错时发送 `run-error` 事件

**Session Key**

`sessionKey` **必填**，取值**完全由 APP 决定**；插件写入 `sessions.json`、对话历史文件名、`dispatchReplyWithDispatcher` 的 `SessionKey` 时均**使用请求中的原字符串，不做规范化或映射**。

`/friday/history` 查询参数中的 `sessionKey` 必须与发消息时 APP 使用的字符串**一致**（同样原样匹配）。

**注意：** OpenClaw 内核对部分路径会使用 `validateSessionId()`（仅允许 `/^[a-z0-9][a-z0-9._-]{0,127}$/i`）。若 APP 传入含冒号等字符的 `sessionKey`，可能在 Agent 调度阶段出现 `Invalid session ID`；这属于**内核与 APP 取值**之间的一致性问题，本插件按你的要求不再改写 `sessionKey`。

---

## 接口：上传文件

### `POST /friday/files`

上传文件（图片、音频等），返回文件 ID 供消息引用。

**请求**

```
POST /friday/files
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

| 表单字段 | 类型 | 必填 | 说明 |
|----------|------|------|------|
| `file` | binary | 是 | 文件内容 |
| `deviceId` | string | 是 | 设备标识 |
| `mimeType` | string | 否 | MIME 类型覆盖（省略时自动从 Content-Type 检测） |

**响应** — `200 OK`

```json
{
  "id": "uuid.png",
  "mimeType": "image/png",
  "size": 123456
}
```

**错误响应**

| 状态码 | 条件 |
|--------|------|
| `400 Bad Request` | 缺少 `file` 或 `deviceId` |
| `401 Unauthorized` | 缺少或无效 bearer token |

**注意事项**

- 文件存储在 OpenClaw 媒体缓冲区：`~/.openclaw/media/inbound/<uuid>`
- 返回的 `id`（如 `"uuid.png"`）作为 `attachments[]` 字段在 `POST /friday/messages` 中引用
- 附件发送给 Agent 时，以 `[media attached: media://inbound/<id>]` 模式嵌入 `BodyForAgent`

---

## 接口：下载文件

### `GET /friday/files/:id`

下载已上传的文件。

**请求**

```
GET /friday/files/:id
Authorization: Bearer <token>
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `:id` | string | 文件 ID（来自 `POST /friday/files` 的返回值，可能包含扩展名如 `abc123.png`） |

**响应** — `200 OK`

```
Content-Type: <mimeType>
Content-Length: <size>
<二进制文件内容>
```

**回退搜索**

如果内存索引中找不到文件，Handler 会在 OpenClaw 媒体缓冲区中搜索：

1. `~/.openclaw/media/inbound/<id>`（按原 id，如 `abc123.png`）
2. `~/.openclaw/media/inbound/<id去掉扩展名>`（如 `abc123`）

**错误响应**

| 状态码 | 条件 |
|--------|------|
| `404 Not Found` | 文件未找到 |
| `401 Unauthorized` | 缺少或无效 bearer token |

---

## 接口：对话历史

### `GET /friday/history`

查询会话的对话历史。

**请求**

```
GET /friday/history?sessionKey=<sessionKey>
Authorization: Bearer <token>
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionKey` | string | 是 | 发送消息时使用的 sessionKey |

**响应** — `200 OK`

```typescript
interface ConversationSession {
  sessionKey: string;
  rounds: ConversationRound[];   // 最新在前，最多 25 轮
  updatedAt: number;           // Unix 毫秒时间戳
}

interface ConversationRound {
  roundId: number;             // 从 1 开始的显示序号
  runId: string;
  user: {
    text: string;
    attachments: string[];      // 如 ["/friday/files/uuid.png"]
    timestamp: number;
  };
  assistant: {
    messages: HistoryMessage[]; // 所有 Assistant 消息（含 reasoning dump + blocks）
    reasoning: string;         // 流式推理文本
    timestamp: number;
    isError: boolean;
    error?: string;
  };
  status: "streaming" | "completed" | "error";
}

interface HistoryMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachments: string[];
  timestamp: number;
}
```

**空历史响应** — `200 OK`

```json
{
  "sessionKey": "my-session",
  "rounds": []
}
```

**错误响应**

| 状态码 | 条件 |
|--------|------|
| `400 Bad Request` | 缺少 `sessionKey` |
| `401 Unauthorized` | 缺少或无效 bearer token |

---

### `DELETE /friday/history`

清除指定会话的全部对话历史。

**请求**

```
DELETE /friday/history?sessionKey=<sessionKey>
Authorization: Bearer <token>
```

**响应** — `200 OK`

```json
{
  "ok": true,
  "sessionKey": "my-session"
}
```

**错误响应**

| 状态码 | 条件 |
|--------|------|
| `400 Bad Request` | 缺少 `sessionKey` |
| `401 Unauthorized` | 缺少或无效 bearer token |

**注意事项**

- 历史存储路径：`~/.openclaw/agents/main/sessions/friday-history/<sessionKey>.json`
- Gateway 启动时自动加载所有历史
- 每个 session 最多保存 25 轮，超出后自动裁剪最旧轮次
- 轮次按最新在前存储（`unshift`）
- 推理内容在推理结束时以 hidden assistant message 形式存入 `assistant.messages`（id: `reasoning-<runId>`）

---

## Agent → iOS：出站适配器

插件实现了 `ChannelOutboundAdapter`，支持 Agent 主动向 iOS App 推送消息和媒体。

### `sendText`

```typescript
sendText(ctx: SendTextContext): Promise<void>
```

向 iOS App 发送文本消息，通过 SSE `agent` 事件推送：

```json
{"type":"agent","data":{"event":"message","text":"Hello from the agent","deviceId":"<to>"}}
```

### `sendMedia`

```typescript
sendMedia(ctx: SendMediaContext): Promise<void>
```

向 iOS App 发送媒体消息：

1. 从磁盘读取文件（`ctx.mediaPath`）
2. 通过 `saveMediaBuffer()` 保存到 OpenClaw 媒体缓冲区
3. 发送 SSE 事件：

```json
{"type":"agent","data":{"event":"media","mediaUrl":"/friday/files/<savedId>","deviceId":"<to>"}}
```

### 目标解析

当 Agent 向 channel `"friday"` 且目标为 `"<deviceId>"` 发送消息时：

1. `normalizeTarget(raw)` → 返回去掉首尾空格的原始字符串（空字符串则返回 `"friday"`）
2. `targetResolver.resolveTarget(ctx)` → 返回 `{ to: ctx.normalized }`（即 deviceId）
3. `sendText` / `sendMedia` 使用 `ctx.to` 作为 deviceId 进行 SSE 路由

**Prompt 提示**：`"Use the deviceId (e.g. your device identifier)."`

---

## Session 级别配置

每个 session（以 `sessionKey` 标识）可配置推理/思考级别：

| 级别 | 效果 |
|------|------|
| `reasoningLevel: "stream"` | 通过 SSE 流式推送推理内容 |
| `thinkingLevel: "low" \| "medium" \| "high"` | 控制模型思考深度 |

插件在每次收到消息时调用 `ensureSessionLevels(sessionKey, "stream", "medium")`，在 `sessions.json` 中创建或更新 session 条目：

```
~/.openclaw/agents/main/sessions/sessions.json
```

文件中存储的 sessionKey 使用与 gateway 相同的 canonicalization（见上方 Session Key 说明）。

---

## 文件存储位置

| 用途 | 路径 |
|------|------|
| 对话历史 | `~/.openclaw/agents/main/sessions/friday-history/<sessionKey>.json` |
| 历史索引 | `~/.openclaw/agents/main/sessions/friday-history/index.json` |
| Session 配置 | `~/.openclaw/agents/main/sessions/sessions.json` |
| OpenClaw 媒体缓冲区 | `~/.openclaw/media/inbound/<uuid>` |

---

## 错误处理

| 场景 | 行为 |
|------|------|
| 无效 JSON 请求体 | `400 Bad Request` |
| 缺少 bearer token | `401 Unauthorized` |
| 缺少必填字段 | `400 Bad Request`（含字段名） |
| 文件未找到 | `404 Not Found` |
| Agent 分发错误 | SSE `run-error` 事件，历史标记为 `error` |
| SSE 连接断开 | 清理连接，Run 取消追踪 |
| 持久化失败 | 尽力而为，内存状态继续工作 |

---

## 端口

Gateway HTTP 服务默认运行在端口 **18789**。所有 `/friday/*` 路由访问地址：

```
http://localhost:18789/friday/...
```
