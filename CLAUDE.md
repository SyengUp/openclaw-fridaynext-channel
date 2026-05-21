# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Guidance for working in this repository (OpenClaw `friday-next` channel plugin).

## Commands

```bash
pnpm build           # Compile TS to dist/ (required before gateway restart)
./install.js        # One-click: install deps, build, and configure OpenClaw
pnpm test:unit       # Vitest unit tests (excludes *.e2e.test.ts)
pnpm test:e2e        # Vitest e2e (vitest.e2e.config.ts)
pnpm test            # unit then e2e
pnpm test:smoke      # Live gateway smoke (optional, needs running gateway)
pnpm test:msg-live   # Live message roundtrip (needs running gateway)

# Run a single test file
pnpm vitest run src/http/handlers/messages.test.ts
pnpm vitest run --config vitest.e2e.config.ts src/e2e/send-text.e2e.test.ts
```

Both vitest configs auto-detect the OpenClaw dist directory from standard install paths (`/opt/homebrew`, `/usr/local`, nvm). If your OpenClaw is installed elsewhere, set the `OPENCLAW_DIST` env var or update the candidates in both configs.

## Architecture

### Data flow

```
iOS App ←--HTTP/SSE--→ Friday Plugin ←--OpenClaw Plugin API--→ Gateway + Agent
                            │
                       [sseEmitter] — broadcasts events to connected devices
                            │
                    [offline-queue] — JSONL per-device persistence for replay
```

1. **`index.ts`** — Plugin entry. Registers HTTP routes, `onAgentEvent` → `forwardAgentEventRaw`, tool hooks (`before_tool_call`/`after_tool_call` → `tool-hook` SSE), and a `subagent_delivery_target` hook (routes sub-agent completion responses back to the Friday device that initiated the run). Uses Symbol-keyed dedupe guards (one route registration and one hook registration per process).
2. **`src/channel.ts`** — Plugin channel definition; `sendText` / `sendMedia` → `sseEmitter.broadcast(..., type: "outbound")` (plus media URL handling via `saveMediaBuffer` / `resolveMediaAttachment`).
3. **`src/http/server.ts`** + **`src/http/handlers/*`** — `/friday-next/*` routes. Full route table:
   - `GET /friday-next/events` — SSE stream (`handleSseStream`)
   - `POST /friday-next/messages` — message dispatch (`handleMessages`)
   - `POST /friday-next/files` — multipart upload (`handleFilesUpload`)
   - `GET /friday-next/files/:id` — file download (`handleFilesDownload`)
   - `POST /friday-next/cancel` — abort a run (`handleCancel`)
   - `POST /friday-next/device-approve` — device trust approval (`handleDeviceApprove`)
   - `DELETE /friday-next/sessions` — delete a session + transcript (`handleSessionsDelete`)
   - `PUT|GET /friday-next/sessions/settings` — read/write session settings (`handleSessionsSettings`)
   - `GET /friday-next/models` — list available models (`handleModelsList`)
   - `GET /friday-next/status` — active runs + connection count (`handleStatus`)
4. **`src/sse/emitter.ts`** — Singleton `sseEmitter`: connections, per-device monotonic SSE ids, `broadcast` / `broadcastToRun` / `broadcastToolEvent`, integrates **`src/sse/offline-queue.ts`** (JSONL writes before socket write; `connected` events are NOT persisted).
5. **`src/friday-session.ts`** — `deviceId` ↔ `sessionKey` mapping (multiple lookup tables for different key forms); **`forwardAgentEventRaw`** handles:
   - **Thinking delta rewriting** — OpenClaw sends cumulative `data.text` for `stream: "thinking"`; this module computes true incremental `delta` by tracking per-run last-seen text and emitting only the suffix.
   - **Lifecycle metadata merging** — terminal `lifecycle` (`phase: "end"`) frames get `modelName`/`totalTokens`/`contextTokensUsed`/`contextWindowMax` from `run-metadata.ts`.
   - **Terminal lifecycle deferral** — `lifecycle end/error` is deferred with `setImmediate` so the session store flush completes first, then `sessionUsageSnapshot` is read and merged into the frame.
6. **`src/agent/dispatch-bridge.ts`** — `runFridayDispatch` lazy-loads `openclaw/plugin-sdk/reply-dispatch-runtime` via dynamic `import()`. Test mock via `__setMockFridayDispatchForTests`.
7. **`src/agent/active-runs.ts`** — Lifecycle-derived `activeRuns` (tracks `phase: start` / `end` / `error`) for `GET /status`.
8. **`src/agent/subagent-registry.ts`** — Tracks subagent lifecycle (`spawning` → `running` → `ended`). Maintains `childSessionKey` / `runId` → `SubagentEntry` maps. `resolveDeviceIdForRequesterChain` walks the `requesterSessionKey` chain to find the owning device. Supports nested subagents. `forwardAgentEventRaw` queries `lookupByRunId` to annotate subagent `agent` SSE frames with `{ label, parentRunId, depth }`.
9. **`src/config.ts`** + **`src/runtime.ts`** + **`src/host-config.ts`** — Config resolution chain: runtime store → `loadConfig()` → `channels["friday-next"]` with defaults/bounds. Tests inject config via `setMockRuntime`.
10. **`src/run-metadata.ts`** — Per-run in-memory metadata (model name, tokens, context window) extracted from agent events. Also tracks `runId` → `deviceId` routes. In `handleMessages`, if `deliver(kind: "final")` fires before metadata arrives, a **`scheduleLateFinalMetaPatch`** retries up to 6 times (300ms intervals) to emit a `final_meta` outbound SSE when metadata eventually lands.
11. **`src/session/session-manager.ts`** — Session level persistence (`reasoningLevel`/`thinkingLevel`/`modelRef`) in `sessions.json` at `~/.openclaw/agents/main/sessions/sessions.json`. Session key normalization via `toSessionStoreKey`: `"main"` → `"agent:main:main"`, other bare keys get `"agent:main:<key>"` prefix.
12. **`src/agent-forward-runtime.ts`** — Bridges to OpenClaw Agent API (`resolveStorePath`, `loadSessionStore`, `getConfig`) so `forwardAgentEventRaw` can read session store after persist for terminal lifecycle frames.
13. **`src/agent-run-context-bridge.ts`** — Reads agent run context (`sessionKey`) from `Symbol.for("openclaw.agentEvents.state")` global singleton. Used when `onAgentEvent` payload has no `sessionKey` (Control-UI-hidden runs).
14. **`src/session-usage-snapshot.ts`** — Builds `FridaySessionUsagePayload` DTO from session store entries for terminal lifecycle SSE frames (`data.sessionUsage`).
15. **`src/agent/media-bridge.ts`** — `saveInboundMediaBuffer`: saves attachment buffers via `openclaw/plugin-sdk/media-store` (with tempdir fallback for tests).
16. **`src/http/handlers/files.ts`** — Central file store: `attachments/` directory under plugin root, in-memory index, `storeFile`/`readFile`/`resolveMediaUrl`/`resolveMediaAttachment`. Handles `file://` URI resolution and `~/` expansion for agent-provided paths.

### Supporting modules

- **`src/channel-actions.ts`** — `describeMessageActions` / `handleMessageAction` for the channel's message-tool integration (`send`, `channel-info`, `channel-list`).
- **`src/friday-inbound-stats.ts`** — Tracks last `POST /messages` timestamp for Control UI channel health display.
- **`src/logging.ts`** — Scoped logger factory (`[friday-next:<scope>]` prefix, level-gated).
- **`src/vendor/runtime-store.ts`** — Vendored from OpenClaw SDK; `Symbol.for("openclaw.plugin-sdk.runtime-store-registry")`-based runtime singleton. Kept here to avoid importing the full gateway graph in tests.
- **`src/openclaw.d.ts`** — Ambient module declarations for `openclaw/plugin-sdk/*` imports (avoids depending on the full SDK type bundle).
- **`src/collect-message-media-paths.ts`** — Extracts local filesystem paths (`/Users/.../file.ext`, `mediaUrl`, `filePath`, `audioPath`) from tool result JSON/strings. Used by outbound media delivery to resolve agent-generated files.
- **`openclaw.plugin.json`** — Plugin manifest declaring channel metadata, config schema (auth token, CORS, SSE keepalive/backlog), UI hints (sensitive fields), and env vars (`FRIDAY_NEXT_AUTH_TOKEN`).

## SSE event names

`connected` | `agent` | `deliver` | `tool-hook` | `outbound` | `ping` | `subagent`

`subagent` events carry `phase: "spawning"|"spawned"|"ended"` with `runId`, `parentRunId`, `label`, `depth`, `deviceId` for subagent lifecycle UI.

Do not reintroduce `run-start` / `run-complete` / `run-error` / `final` / `reasoning` / `block` / `attachment` / `tts` as top-level SSE events.

## Message flow (`POST /messages`)

Validate auth → `ensureSessionLevels` / session mapping → `runFridayDispatch` with `deliver` → `deliver` SSE (+ URL translation + `channelData.fridayNext` metadata); errors → `outbound` `dispatch_error`. No plugin-side conversation history.

`ensureSessionLevels` writes `reasoningLevel` and `thinkingLevel` into `~/.openclaw/agents/main/sessions/sessions.json` keyed by the normalized session key (`"agent:main:<raw>"`).

When `deliver(kind: "final")` fires before model/token metadata has arrived via agent events, the handler falls back to `resolveRunMetadataFromRuntimeSession` (reads recent assistant messages from the session store), and if that also fails, schedules `scheduleLateFinalMetaPatch` (polling retry up to ~1.8s).

## Tool hook flow

`before_tool_call` / `after_tool_call` → `shouldForwardToolEventToFriday` (checks runId→deviceId mapping, then sessionKey→deviceId, then `isFridaySessionKey` pattern match) → `deviceIdFromToolContext` (runId → sessionKey → sole connected device → last registered) → `broadcastToolEvent(type: "tool-hook", ...)` sent only to the owning device. Each hook fires a `console.error` log line prefixed `[Friday-HOOK]` for debugging.

## `subagent_delivery_target` hook

When a sub-agent run completes and `expectsCompletionMessage` is true, this hook checks if the requester origin channel is `friday-next` and resolves the device ID from the requester's session key. Returns an `origin` descriptor so OpenClaw routes the sub-agent's completion message back to the correct Friday device.

## Config (`src/config.ts`)

From `channels["friday-next"]`: `authToken`, `historyDir` (default `~/.openclaw/friday-next/history`), `sse.backlogPerDevice`, `sse.keepaliveSec`, CORS fields. Offline queue dir: `dirname(historyDir) + "/events-queue"`. Auth token resolution order: `gateway.auth.token` → `channels["friday-next"].authToken` → `FRIDAY_NEXT_AUTH_TOKEN` env var.

### Owner-only tools (`nodes`) from Friday App

OpenClaw filters `nodes` by **profile** and **owner**. To verify or fix visibility:

1. If using `tools.profile: "coding"` (or similar), add **`tools.alsoAllow: ["nodes"]`** — profile allowlists do not re-include tools removed at profile resolution; `alsoAllow` does.
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
