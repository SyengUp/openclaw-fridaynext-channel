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

`POST /friday-next/cancel`，body：`{ "runId" }`。返回 `200`；在可用时调用 OpenClaw harness 中止；**不再**由插件单独发 `run-error`。

## 状态

`GET /friday-next/status`：在英文版基础上增加 `activeRuns`、`activeRunCount`（由 lifecycle 跟踪）。

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
