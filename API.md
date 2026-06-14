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
| `agent`     | OpenClaw `onAgentEvent` | Full native stream (`lifecycle`, `assistant`, `tool`, `thinking`, …); subagent events include `subagent` annotation |
| `deliver`   | Dispatch `deliver` callback | `kind`: `tool` \| `block` \| `final`; payload with media URLs rewritten to `/friday-next/files/:id`; `final` may include `channelData.fridayNext.modelName/totalTokens` |
| `tool-hook` | `before_tool_call` / `after_tool_call` | Hook payload + `runId`, `deviceId`, `sessionKey` |
| `outbound`  | Channel `sendText` / `sendMedia`, dispatch errors | Proactive push or `op: "dispatch_error"` |
| `subagent`  | Plugin hooks | Subagent lifecycle: `phase: "spawning"` \| `"spawned"` \| `"ended"` |
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

### `subagent` data

Subagent lifecycle events track the creation, activation, and termination of sub-agent runs. When the main agent invokes a tool that spawns a sub-agent (e.g. `task`), the plugin emits three phased SSE events.

#### Phase: `"spawning"`

Emitted as early as possible — when the sub-agent spawn is requested but before the child run is created. Use this to show an immediate "Creating sub-task…" indicator in the UI. There is **no `runId`** yet at this stage.

```json
{
  "type": "subagent",
  "data": {
    "phase": "spawning",
    "childSessionKey": "agent:main:subagent:code-reviewer",
    "label": "code-reviewer",
    "parentRunId": "main-run-001",
    "depth": 1,
    "deviceId": "DEVICE-AAAA-BBBB"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `phase` | `"spawning"` | Lifecycle phase |
| `childSessionKey` | `string` | The sub-agent's session key (persistent identifier across spawning→spawned→ended) |
| `label` | `string \| null` | Sub-agent display name (e.g. `"code-reviewer"`, `"lint"`). `null` if unnamed |
| `parentRunId` | `string \| null` | The immediate parent's `runId`. `null` if the parent runId couldn't be resolved |
| `depth` | `number` | Nesting depth. `1` for the first level, `2` for a sub-agent spawned by another sub-agent, etc. |
| `deviceId` | `string` | Owning Friday device UUID (uppercase) |

#### Phase: `"spawned"`

Emitted after the child run has been created. The `runId` is now available — all subsequent `agent` events for this sub-agent will carry this `runId`.

```json
{
  "type": "subagent",
  "data": {
    "phase": "spawned",
    "runId": "sub-run-abc123",
    "childSessionKey": "agent:main:subagent:code-reviewer",
    "label": "code-reviewer",
    "parentRunId": "main-run-001",
    "depth": 1,
    "deviceId": "DEVICE-AAAA-BBBB"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `phase` | `"spawned"` | Lifecycle phase |
| `runId` | `string` | The sub-agent's run ID — matches `runId` in subsequent `agent` SSE events |
| `childSessionKey` | `string` | Same session key as in `spawning` |
| `label` | `string \| null` | Same as `spawning` |
| `parentRunId` | `string \| null` | Same as `spawning` |
| `depth` | `number` | Same as `spawning` |
| `deviceId` | `string` | Same as `spawning` |

#### Phase: `"ended"`

Emitted when the sub-agent run terminates, regardless of outcome.

```json
{
  "type": "subagent",
  "data": {
    "phase": "ended",
    "runId": "sub-run-abc123",
    "childSessionKey": "agent:main:subagent:code-reviewer",
    "label": "code-reviewer",
    "parentRunId": "main-run-001",
    "depth": 1,
    "deviceId": "DEVICE-AAAA-BBBB",
    "outcome": "ok",
    "error": null
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `phase` | `"ended"` | Lifecycle phase |
| `runId` | `string \| null` | The sub-agent's run ID (may be `null` if the run was never created) |
| `childSessionKey` | `string` | Same session key |
| `label` | `string \| null` | Same |
| `parentRunId` | `string \| null` | Same |
| `depth` | `number` | Same |
| `deviceId` | `string` | Same |
| `outcome` | `"ok" \| "error" \| "timeout" \| "killed" \| "reset" \| "deleted" \| null` | Termination outcome |
| `error` | `string \| null` | Error message when outcome is `"error"` or `"timeout"` |

#### Lifecycle state machine

```
spawning  ──→  spawned  ──→  ended
   │                            ↑
   └──── spawn-failed ──────────┘
```

If the spawn itself fails (e.g. session creation rejected), the plugin may go directly from `spawning` to `ended` without a `spawned` frame. In that case `phase: "ended"` will have `outcome: "error"` and `runId: null`.

---

### Subagent `agent` event annotation

All `agent` SSE events that belong to a sub-agent run carry an extra `subagent` field. The presence of this field is the canonical way to distinguish main-agent events from sub-agent events.

```json
{
  "type": "agent",
  "data": {
    "runId": "sub-run-abc123",
    "seq": 14,
    "ts": 1710000001000,
    "stream": "thinking",
    "data": {
      "text": "Analyzing the code for issues…",
      "delta": "issues…",
      "reasoningPrefixChars": 27
    },
    "sessionKey": "agent:main:subagent:code-reviewer",
    "subagent": {
      "label": "code-reviewer",
      "parentRunId": "main-run-001",
      "depth": 1
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `subagent` | `object` | **Present only for sub-agent events.** Absent for main-agent events |
| `subagent.label` | `string \| undefined` | Sub-agent display name |
| `subagent.parentRunId` | `string \| undefined` | Immediate parent's `runId` |
| `subagent.depth` | `number` | Nesting depth |

`agent` events from the main run **do not** have the `subagent` field.

#### App-side grouping logic

```pseudocode
on SseFrame frame:
  if frame.event == "agent":
    if frame.data.subagent exists:
      // This is a sub-agent event
      groupBy = frame.data.subagent.label ?? frame.data.runId
      parent  = frame.data.subagent.parentRunId
      depth   = frame.data.subagent.depth
    else:
      // This is a main-agent event
      groupBy = frame.data.runId
```

### Nested sub-agents

Sub-agents can spawn other sub-agents. Each level increments `depth` and `parentRunId` points to the immediate parent:

```
Main run (runId=MAIN, depth=0)
  │
  ├─ subagent "reviewer" (runId=REV, depth=1, parentRunId=MAIN)
  │     │
  │     ├─ agent events annotated: { subagent: { label:"reviewer", parentRunId:MAIN, depth:1 } }
  │     │
  │     └─ subagent "lint" (runId=LINT, depth=2, parentRunId=REV)
  │           │
  │           ├─ agent events annotated: { subagent: { label:"lint", parentRunId:REV, depth:2 } }
  │           └─ ended
  │
  └─ ended
```

The app can indent sub-agent UI blocks by `depth` and nest them under the parent identified by `parentRunId`.

### Complete subagent lifecycle (SSE frame sequence)

```
SSE event: subagent  phase=spawning   childSessionKey=… label="code-reviewer" parentRunId=MAIN depth=1
SSE event: subagent  phase=spawned    runId=REV  childSessionKey=… label="code-reviewer"
SSE event: agent     stream=thinking  runId=REV  subagent={label:"code-reviewer", parentRunId:MAIN, depth:1}
SSE event: agent     stream=lifecycle runId=REV  data.phase=start   subagent={…}
SSE event: agent     stream=tool      runId=REV  data.phase=start   subagent={…}  toolName=read
SSE event: agent     stream=tool      runId=REV  data.phase=end     subagent={…}  toolName=read
SSE event: agent     stream=assistant runId=REV  subagent={…}
SSE event: subagent  phase=ended      runId=REV  outcome=ok
```

**Note:** The `subagent` lifecycle events and `agent` events are emitted on the same SSE connection. `agent` events for the sub-agent can arrive between `spawned` and `ended` (and may even briefly overlap with main-agent events if the main agent continues working in parallel).

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
{ "sessionKey": "...", "runId": "..." }
```

`sessionKey` is the primary identifier — a session has at most one active run, so the
plugin resolves it to the run's internal `sessionId` and calls OpenClaw's agent harness
**abort-and-drain** (waits for the run to settle). `runId` is an optional back-compat
fallback: when `sessionKey` is omitted it is resolved to a sessionKey via the run route,
and it is also used to untrack SSE forwarding. At least one of the two is required (else
`400`). Returns `200` with `{ ok, sessionKey, runId, aborted, drained }`. There is **no**
plugin-emitted `run-error` for cancel; observe `agent` / `lifecycle` on the client.

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

## Agent management

Read and edit a single agent's configuration the same way OpenClaw's ControlUI does, but written through the plugin's own config channel (`api.runtime.config.mutateConfigFile`) — **no OpenClaw core changes**. Config edits land in `agents.list[]` of the host config file; core `.md` files are written directly into the agent's workspace dir. `{id}` is normalized like OpenClaw's session-key agent id (trim/lowercase/slug; empty → `main`).

### GET /friday-next/agents/{id}/config

```json
{
  "ok": true,
  "id": "main",
  "exists": true,
  "model": "openai/gpt-5",
  "thinkingDefault": "high",
  "tools": { "profile": "default", "allow": ["read"], "alsoAllow": [], "deny": ["bash"] },
  "skills": ["deep-research"],
  "availableSkills": ["deep-research", "verify"]
}
```

- `exists` — whether a matching `agents.list[]` entry exists (an implicit agent like `main` may have none yet).
- `model` — verbatim config value: a string or `{ "primary", "fallbacks" }`. `undefined` ⇒ inherits `agents.defaults`.
- `skills` — configured allow-list. `undefined` ⇒ inherit defaults; `[]` ⇒ all skills disabled.
- `availableSkills` — full catalog of loadable skills (for a skills picker), each `{ id, source, description? }`. `source` is `"workspace" | "installed" | "extra" | "built-in"` (deduped by id, workspace wins). `id`/`description` come from the `SKILL.md` frontmatter `name`/`description` (recursively discovered). Aggregates the agent's workspace `skills/`, the shared default-agent workspace, the managed dir (`<configDir>/skills`), `skills.load.extraDirs`, and bundled core/extension skills. Excludes ClawHub-remote-only skills and eligibility flags.

### PUT /friday-next/agents/{id}/config

Partial patch — only the keys present in the body change. An explicit `null` **clears** the field (deletes it so the config merge falls back to `agents.defaults`); omitting a key leaves it untouched.

```json
{
  "model": "openai/gpt-5",
  "thinkingDefault": "medium",
  "tools": { "profile": "default", "deny": ["bash"] },
  "skills": []
}
```

- `model` — string, `{ "primary", "fallbacks" }`, or `null` (clear).
- `skills` — array of skill ids, `[]` (disable all), or `null` (clear → inherit). A non-array, non-null value is `400`.
- If the agent has no `agents.list[]` entry, a bare `{ id }` entry is created (never marked `default`).

Responds `200` with the refreshed config view. The write uses `afterWrite: { mode: "auto" }`, letting the gateway pick hot-reload vs restart.

### GET /friday-next/agents/{id}/tools/catalog

The agent's full tool catalog for a toolbox editor (core + plugin tools, mirroring ControlUI). Built from core's `buildToolsCatalogResult` (resilient deep-import, graceful 503 if unavailable). Edits are saved via `PUT …/config` (`tools`).

```json
{
  "ok": true,
  "id": "main",
  "profile": "full",
  "profiles": [{ "id": "minimal", "label": "Minimal" }, { "id": "coding", "label": "Coding" }, { "id": "messaging", "label": "Messaging" }, { "id": "full", "label": "Full" }],
  "groups": [
    {
      "id": "fs", "label": "Files", "source": "core",
      "tools": [{ "id": "read", "label": "read", "description": "Read file contents", "source": "core", "enabled": true, "inProfile": true }]
    }
  ]
}
```

- `profile` — the agent's configured profile (null when unset). `profiles` — the selectable presets.
- `enabled` — the tool's effective state under the current `tools` config. `inProfile` — whether the active profile grants it (drives the allow/deny delta when the app toggles a tool).
- `groups[].source` is `"core" | "plugin"` (`pluginId` set for plugin groups). Plugin tools are included only for enabled plugins.

### Core files

Whitelist: `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `TOOLS.md`, `MEMORY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`. Written directly into the workspace — no restart; the agent re-reads them on its next run.

- `GET /friday-next/agents/{id}/files` — status of every whitelist file:

  ```json
  { "ok": true, "id": "main", "files": [{ "name": "IDENTITY.md", "exists": true, "bytes": 512 }] }
  ```

- `GET /friday-next/agents/{id}/files/{name}` — `{ "ok": true, "name": "IDENTITY.md", "exists": true, "content": "..." }` (missing file ⇒ `exists:false`, empty `content`).
- `PUT /friday-next/agents/{id}/files/{name}` — body `{ "content": "..." }`. Non-whitelist or traversal names ⇒ `400`; content over 256 KiB ⇒ `413`.

## Removed endpoints

- `GET` / `DELETE /friday-next/history` — **removed.** Build conversation state from the SSE stream on the client.
