# Friday Channel Plugin API Documentation

## Overview

The Friday Channel Plugin is an OpenClaw plugin that bridges an iOS app with the OpenClaw agent runtime. It provides:

- **Inbound**: iOS app → agent via HTTP POST + SSE streaming response
- **Outbound**: agent → iOS app via outbound adapter + SSE push
- **History**: per-session conversation history with JSON file persistence

All endpoints are under the `/friday/` path prefix, registered via `api.registerHttpRoute()`.

---

## Authentication

All endpoints require a `Authorization: Bearer <token>` header. The plugin validates the bearer token against the value configured in `openclaw.json` under `gateway.auth.token`. If missing, malformed, or does not match, returns `401 Unauthorized`.

The plugin shares the same token as the gateway's WebSocket connections — use the gateway's configured auth token for all requests.

---

## Client: HTML instead of SSE?

If the response **`Content-Type` is `text/html`** or the body starts with **`<!doctype html>`**, the request **did not reach the Friday plugin** — the OpenClaw **control UI (SPA)** served a page instead. This is not the plugin's `401` JSON.

**Checklist:**

1. **`channels.friday` must not be only `{ "enabled": true }`**. At gateway startup, OpenClaw treats channel blocks with **no keys other than `enabled`** as *not meaningfully configured*, so it **does not load** the Friday channel plugin and `/friday/*` falls through to the Control UI HTML. Add **at least one extra field**, for example:
   ```json
   "friday": {
     "enabled": true,
     "transport": "http+sse"
   }
   ```
   Then **restart the gateway** (e.g. `openclaw gateway restart`).
2. **`plugins.entries.friday`** is enabled (in addition to the above).
3. **Exact paths**: SSE is **`GET /friday/events?deviceId=...`** (not `/friday` alone). Messages are **`POST /friday/messages`** (plural), not `/friday/message`.
4. **Host and port** match the gateway process (default **`http://<host>:18789`**).
5. Gateway logs should show **`Friday channel HTTP routes registered`**; if missing, plugin HTTP routes are not registered and clients will keep getting HTML.

Quick probe:

```bash
curl -sS -D - "http://127.0.0.1:18789/friday/events?deviceId=test" \
  -H "Authorization: Bearer <token>" -o /tmp/out --max-time 2
```

When the plugin handles the request, expect **`Content-Type: text/event-stream`**. If you still see **`text/html`**, work through the checklist above.

---

## Endpoint: SSE Stream

### `GET /friday/events`

Establishes a persistent SSE (Server-Sent Events) connection for real-time event delivery.

**Request**

```
GET /friday/events?deviceId=<deviceId>
Authorization: Bearer <token>
```

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `deviceId` | string | Yes      | Unique device identifier (UUID or custom string) |

**Response** — `200 OK`, `Content-Type: text/event-stream`

Sends an initial `connected` event, then streams events as they occur.

**SSE Event Format**

Each event is a plain JSON line terminated by `\n` (no `data:` prefix):

```json
{"type":"eventType","phase":"...","...":""}
```

**SSE Events**

| Event Type | Description | Data Fields |
|------------|-------------|-------------|
| `agent` | Connection or run lifecycle | `{ event: "connected" \| "run-start" \| "message" \| "media", deviceId?, runId?, timestamp }` |
| `reasoning` | Reasoning stream | `phase: "start" \| "delta" \| "end"`, `{ text?, runId, timestamp }` |
| `tool` | Tool call lifecycle | `phase: "start" \| "end" \| "error"`, `{ toolName, params?, toolCallId?, error?, text?, durationMs?, runId, deviceId, timestamp }` |
| `final` | Response stream | `phase: "start"` injected when first `deliver("final")` or `onPartialReply` fires; content events have no `phase` field; `done: true` (via `notifyRunComplete`) signals `phase: "end"` |
| `block` | Assistant block (code/image) | `{ text, mediaUrls, isError, runId, deviceId }` |
| `run-complete` | Agent run finished | `{ runId }` |
| `run-error` | Agent run failed | `{ runId, error }` |

**Phase Field**

- `reasoning` and `final` use a consistent `phase` field: `start` → `delta` (×N) → `end`
- `tool` uses `phase: "start"` / `"end"` / `"error"`
- `block` and `run-complete`/`run-error` do not use `phase`

**Keepalive**: server sends `: keepalive\n\n` every 30 seconds.

**Example**

```bash
curl -N -X GET "http://localhost:18789/friday/events?deviceId=MY-DEVICE" \
  -H "Authorization: Bearer my-token"
```

```json
{"type":"agent","event":"connected","deviceId":"MY-DEVICE","timestamp":1775099965312}

{"type":"reasoning","phase":"start","runId":"abc-123","timestamp":1775099970503}

{"type":"reasoning","phase":"delta","text":"Reasoning: The user is asking...","runId":"abc-123"}

{"type":"reasoning","phase":"end","runId":"abc-123","timestamp":1775099972000}

{"type":"tool","phase":"start","toolName":"exec","params":{"command":"ls"},"runId":"abc-123","deviceId":"MY-DEVICE","timestamp":1775099972050}

{"type":"tool","phase":"end","toolName":"exec","toolCallId":"call_abc","text":"file1.txt\nfile2.txt","durationMs":42,"runId":"abc-123","deviceId":"MY-DEVICE","timestamp":1775099972100}

{"type":"final","phase":"start","runId":"abc-123","timestamp":1775099973000}

{"type":"final","text":"Here are the files in the directory.","mediaUrls":[],"isError":false,"runId":"abc-123","deviceId":"MY-DEVICE"}

{"type":"final","phase":"end","runId":"abc-123","timestamp":1775099975000}

{"type":"run-complete","runId":"abc-123"}
```

---

## Endpoint: Send Message

### `POST /friday/messages`

Sends a user message to the agent. The agent processes it asynchronously; results are streamed back via SSE.

**Request**

```
POST /friday/messages
Authorization: Bearer <token>
Content-Type: application/json
```

**Body**

```typescript
interface FridayMessagePayload {
  deviceId: string;          // Required. Unique device identifier.
  text: string;              // Required. Message text.
  sessionKey: string;        // Required. Chosen by the app; passed through verbatim (no plugin rewriting).
  attachments?: string[];     // Optional. Array of attachment IDs (file IDs from /friday/files).
}
```

| Field | Type   | Required | Description |
|-------|--------|----------|-------------|
| `deviceId` | string | Yes      | Device identifier (must be non-empty) |
| `text` | string | Yes      | Message text (must be non-empty) |
| `sessionKey` | string | Yes      | Session id from the app only; used as-is for `SessionKey`, history, and `sessions.json` |
| `attachments` | string[] | No    | Attachment file IDs previously uploaded via `POST /friday/files` |

**Response** — `202 Accepted` (immediate acknowledgment; processing is async)

```json
{
  "accepted": true,
  "deviceId": "MY-DEVICE"
}
```

**Error Responses**

| Status | Condition |
|--------|-----------|
| `400 Bad Request` | Missing or empty `deviceId`, `text`, or `sessionKey` |
| `401 Unauthorized` | Missing or invalid bearer token |

**Processing Flow**

1. Validate token and payload
2. Return `202 Accepted` immediately
3. Write `reasoningLevel: "stream"` + `thinkingLevel: "medium"` to `sessions.json` (synchronous, before dispatch)
4. Build message body with `[media attached: media://inbound/<id>]` refs for attachments
5. Create conversation history round in background (newest-first, max 25 rounds)
6. Dispatch to agent via `dispatchReplyWithDispatcher()`
7. Stream SSE events back to the device's SSE connection
8. On completion: send `run-complete` event
9. On error: send `run-error` event

**Session Key**

`sessionKey` is **required** and is **only** defined by the app. The plugin forwards the exact string to `SessionKey`, history paths, and `sessions.json` — **no normalization or mapping**.

Use the **same** `sessionKey` query value on `GET/DELETE /friday/history` as in message requests.

**Note:** OpenClaw’s internal `validateSessionId()` only allows `/^[a-z0-9][a-z0-9._-]{0,127}$/i` for some paths. If the app sends a key with colons (e.g. `agent:main:friday-ios`), the run may fail with `Invalid session ID`; the plugin intentionally does not rewrite the key (per app contract). Fix belongs in the app’s chosen id, or in OpenClaw upstream, not in this plugin.

---

## Endpoint: Upload File

### `POST /friday/files`

Uploads a file (image, audio, etc.) and returns a file ID for use in messages.

**Request**

```
POST /friday/files
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

| Form Field | Type | Required | Description |
|------------|------|----------|-------------|
| `file` | binary | Yes      | The file content |
| `deviceId` | string | Yes      | Device identifier |
| `mimeType` | string | No       | MIME type override (auto-detected from Content-Type header if omitted) |

**Response** — `200 OK`

```json
{
  "id": "uuid.png",
  "mimeType": "image/png",
  "size": 123456
}
```

**Error Responses**

| Status | Condition |
|--------|-----------|
| `400 Bad Request` | Missing `file` or `deviceId` |
| `401 Unauthorized` | Missing or invalid bearer token |

**Notes**

- Files are stored in OpenClaw's media buffer: `~/.openclaw/media/inbound/<uuid>`
- The returned `id` (e.g., `"uuid.png"`) is used as `attachments[]` in `POST /friday/messages`
- When sending to the agent, attachments are exposed as `[media attached: media://inbound/<id>]` patterns in `BodyForAgent`

---

## Endpoint: Download File

### `GET /friday/files/:id`

Downloads a previously uploaded file.

**Request**

```
GET /friday/files/:id
Authorization: Bearer <token>
```

| Parameter | Type   | Description |
|-----------|--------|-------------|
| `:id`     | string | File ID returned from `POST /friday/files` (may include extension, e.g. `abc123.png`) |

**Response** — `200 OK`

```
Content-Type: <mimeType>
Content-Length: <size>
<binary file content>
```

**Fallback Search**

If the file is not found in the in-memory index, the handler searches the OpenClaw media buffer:

1. `~/.openclaw/media/inbound/<id>` (id as given, e.g. `abc123.png`)
2. `~/.openclaw/media/inbound/<id_without_extension>` (e.g. `abc123`)

**Error Responses**

| Status | Condition |
|--------|-----------|
| `404 Not Found` | File not found |
| `401 Unauthorized` | Missing or invalid bearer token |

---

## Endpoint: Conversation History

### `GET /friday/history`

Retrieves conversation history for a session.

**Request**

```
GET /friday/history?sessionKey=<sessionKey>
Authorization: Bearer <token>
```

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `sessionKey` | string | Yes      | Session key used when sending messages |

**Response** — `200 OK`

```typescript
interface ConversationSession {
  sessionKey: string;
  rounds: ConversationRound[];   // Newest first, max 25 rounds
  updatedAt: number;             // Unix timestamp ms
}

interface ConversationRound {
  roundId: number;              // 1-based display order
  runId: string;
  user: {
    text: string;
    attachments: string[];      // e.g. ["/friday/files/uuid.png"]
    timestamp: number;
  };
  assistant: {
    messages: HistoryMessage[];  // All assistant messages (reasoning dump + blocks)
    reasoning: string;           // Streaming reasoning text
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

**Empty History Response** — `200 OK`

```json
{
  "sessionKey": "my-session",
  "rounds": []
}
```

**Error Responses**

| Status | Condition |
|--------|-----------|
| `400 Bad Request` | Missing `sessionKey` |
| `401 Unauthorized` | Missing or invalid bearer token |

---

### `DELETE /friday/history`

Clears all conversation history for a session.

**Request**

```
DELETE /friday/history?sessionKey=<sessionKey>
Authorization: Bearer <token>
```

**Response** — `200 OK`

```json
{
  "ok": true,
  "sessionKey": "my-session"
}
```

**Error Responses**

| Status | Condition |
|--------|-----------|
| `400 Bad Request` | Missing `sessionKey` |
| `401 Unauthorized` | Missing or invalid bearer token |

**Notes**

- History is stored at: `~/.openclaw/agents/main/sessions/friday-history/<sessionKey>.json`
- History is auto-loaded on gateway startup
- Max 25 rounds per session; oldest rounds are trimmed on overflow
- Rounds are stored newest-first (`unshift`)
- Reasoning content is dumped into `assistant.messages` as a hidden assistant message (id: `reasoning-<runId>`) when reasoning ends

---

## Agent → iOS: Outbound Adapter

The plugin implements `ChannelOutboundAdapter` so the agent can proactively send messages and media to the iOS app.

### `sendText`

```typescript
sendText(ctx: SendTextContext): Promise<void>
```

Sends a text message to the iOS app via SSE `agent` event:

```json
{"type":"agent","data":{"event":"message","text":"Hello from the agent","deviceId":"<to>"}}
```

### `sendMedia`

```typescript
sendMedia(ctx: SendMediaContext): Promise<void>
```

Sends a media message to the iOS app:

1. Reads the file from disk (`ctx.mediaPath`)
2. Saves to OpenClaw media buffer via `saveMediaBuffer()`
3. Sends SSE event:

```json
{"type":"agent","data":{"event":"media","mediaUrl":"/friday/files/<savedId>","deviceId":"<to>"}}
```

### Target Resolution

When the agent sends a message to channel `"friday"` with target `"<deviceId>"`:

1. `normalizeTarget(raw)` → returns trimmed raw string (or `"friday"` if empty)
2. `targetResolver.resolveTarget(ctx)` → returns `{ to: ctx.normalized }` (the deviceId)
3. `sendText` / `sendMedia` uses `ctx.to` as the deviceId for SSE routing

**Prompt Hint**: `"Use the deviceId (e.g. your device identifier)."`

---

## Session Levels

Each session (identified by `sessionKey`) has configurable reasoning/thinking levels:

| Level | Effect |
|-------|--------|
| `reasoningLevel: "stream"` | Streams reasoning content via SSE |
| `thinkingLevel: "low" \| "medium" \| "high"` | Controls model thinking depth |

The plugin calls `ensureSessionLevels(sessionKey, "stream", "medium")` on every message, creating or updating the session entry in `sessions.json` at:

```
~/.openclaw/agents/main/sessions/sessions.json
```

The `sessionKey` stored in the file uses the same canonicalization as the gateway (see Session Key section above).

---

## File Storage Locations

| Purpose | Path |
|---------|------|
| Conversation history | `~/.openclaw/agents/main/sessions/friday-history/<sessionKey>.json` |
| History index | `~/.openclaw/agents/main/sessions/friday-history/index.json` |
| Session settings | `~/.openclaw/agents/main/sessions/sessions.json` |
| OpenClaw media buffer | `~/.openclaw/media/inbound/<uuid>` |

---

## Error Handling

| Scenario | Behavior |
|---------|----------|
| Invalid JSON body | `400 Bad Request` |
| Missing bearer token | `401 Unauthorized` |
| Missing required fields | `400 Bad Request` with field name |
| File not found | `404 Not Found` |
| Agent dispatch error | SSE `run-error` event, history marked `error` |
| SSE connection closed | Cleaned up, run untracked |
| Persistence failure | Best-effort; in-memory continues |

---

## Port

The gateway HTTP server runs on port **18789** (local) by default. All `/friday/*` routes are accessible at:

```
http://localhost:18789/friday/...
```
