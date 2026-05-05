# Friday Next HTTP/SSE API (v2 — transparent proxy)

The plugin forwards OpenClaw-native streams over SSE and persists outbound events per `deviceId` for offline replay.

## Auth

All routes require:

`Authorization: Bearer <token>`

Token resolution order:

1. `gateway.auth.token`
2. `channels["friday-next"].authToken`
3. `FRIDAY_NEXT_AUTH_TOKEN`

## SSE

`GET /friday-next/events?deviceId=<deviceId>[&lastEventId=<n>]`

Response headers:

- `Content-Type: text/event-stream; charset=utf-8`
- `Cache-Control: no-cache, no-store, must-revalidate`

Frame format (standard SSE):

```text
id: 42
event: agent
data: {"runId":"...","seq":1,"ts":...,"stream":"lifecycle","data":{"phase":"start"}}

```

Keepalive:

```text
: keepalive

```

Replay:

- `Last-Event-ID` header
- `lastEventId` query parameter

After reconnect, the server sends a fresh `connected` frame, then **replays persisted events** with `id` greater than the given last id (see Offline queue).

Notes:

- `id` is monotonic per `deviceId` (not global).
- Payload `deviceId` fields use uppercase normalization where the plugin applies it.
- Browser `EventSource` cannot set `Authorization`; use a client that supports bearer headers.

## Event types (SSE `event:` name)

Only these names are emitted:

| `event`     | Source | Purpose |
|------------|--------|---------|
| `connected` | Plugin | Synthetic handshake: `deviceId`, `serverTime`, `lastSeq` |
| `agent`     | OpenClaw `onAgentEvent` | Full native stream (`lifecycle`, `assistant`, `tool`, `thinking`, …) |
| `deliver`   | Dispatch `deliver` callback | `kind`: `tool` \| `block` \| `final`; payload with media URLs rewritten to `/friday-next/files/:id`; `final` may include `channelData.fridayNext.modelName/totalTokens` |
| `tool-hook` | `before_tool_call` / `after_tool_call` | Hook payload + `runId`, `deviceId`, `sessionKey` |
| `outbound`  | Channel `sendText` / `sendMedia`, dispatch errors | Proactive push or `op: "dispatch_error"` |
| `ping`      | (reserved / internal) | — |

**Removed (breaking):** `run-start`, `run-complete`, `run-error`, `final`, `reasoning`, `block`, `attachment`, `tts`, `tool` as top-level SSE event names, `dispatch`, and any plugin-synthesized “final delta” events. Consume **`agent`** (`stream: "lifecycle"` + `phase`) and **`deliver`** instead.

### `connected` data

```json
{
  "deviceId": "MY-DEVICE",
  "serverTime": 1710000000000,
  "lastSeq": 12
}
```

### `agent` data

OpenClaw agent event payload, e.g. `{ runId, seq, ts, stream, data, sessionKey? }`.

### `deliver` data

```json
{
  "kind": "final",
  "payload": {
    "text": "...",
    "mediaUrls": ["/friday-next/files/..."],
    "channelData": {
      "fridayNext": {
        "mediaKind": "image",
        "modelName": "gpt-5.4",
        "totalTokens": 12345
      }
    }
  },
  "runId": "...",
  "sessionKey": "...",
  "deviceId": "MY-DEVICE",
  "ts": 1710000000000
}
```

### `tool-hook` data

`when`: `"before"` \| `"after"`, plus hook fields and routing ids (`runId`, `deviceId`, `sessionKey`).

### `outbound` data

Cron / sub-agent style pushes: `op`: `"text"` \| `"media"` (and context), `op`: `"dispatch_error"` with `error`, plus late metadata patch `op: "final_meta"` with `runId`, `modelName`, and `totalTokens`.

## Offline queue

For each device, events (except `connected`) are appended to a JSONL file before being written to the socket:

- Default directory: `<dirname(historyDir)>/events-queue` (e.g. `~/.openclaw/friday-next/events-queue/<DEVICE>.jsonl` when `historyDir` is default).
- Trimming: last `sse.backlogPerDevice` entries (from config).

This allows **missed events while offline** or **server restart** to be recovered via `Last-Event-ID` / `lastEventId`.

## POST /friday-next/messages

```json
{
  "deviceId": "IOS-UUID",
  "text": "hello",
  "sessionKey": "my-session",
  "attachments": ["file-id-1.png"]
}
```

Returns `202 Accepted`:

```json
{
  "accepted": true,
  "deviceId": "IOS-UUID",
  "runId": "..."
}
```

The plugin only performs **protocol translation** (attachments → `media://inbound/<id>`, `To` / `OriginatingTo` / command fields for OpenClaw). It does **not** maintain conversation history.

Slash commands (`/…`) use native command source when applicable. `/new` and `/reset` are **not** intercepted locally; they are passed through like any other message text.

## Files

- `POST /friday-next/files` — `multipart/form-data` (`file`, `deviceId`, optional `mimeType`)
- `GET /friday-next/files/:id` — download

## Cancel

`POST /friday-next/cancel`

```json
{ "runId": "..." }
```

Returns `200` and calls OpenClaw’s agent harness abort when available. There is **no** plugin-emitted `run-error` for cancel; observe `agent` / `lifecycle` on the client.

## Status

`GET /friday-next/status`

```json
{
  "ok": true,
  "channel": "friday-next",
  "version": "v2",
  "connections": 1,
  "activeRuns": ["run-id-1"],
  "activeRunCount": 1
}
```

`activeRuns` is derived from `agent` lifecycle `start` / `end` / `error` tracking inside the plugin.

## Removed endpoints

- `GET` / `DELETE /friday-next/history` — **removed.** Build conversation state from the SSE stream on the client.
