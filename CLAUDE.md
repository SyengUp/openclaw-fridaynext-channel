# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is an OpenClaw plugin that bridges a native iOS app ("Friday") with the OpenClaw agent runtime. It is a **TypeScript ESM plugin** loaded by the OpenClaw gateway at runtime — there is no build step or test suite in this repo itself.

## Architecture

The plugin has four main concerns:

1. **Channel definition** (`src/channel.ts`) — declares the "friday" channel to OpenClaw with capabilities (markdown, media) and implements the outbound adapter (`sendText`, `sendMedia`) which pushes events to SSE connections.

2. **HTTP/SSE server** (`src/http/server.ts` + `src/http/handlers/`) — registers routes under `/friday/` on the gateway's HTTP server (port 18789). Handles SSE stream establishment, message dispatch, file upload/download, and history.

3. **SSE emitter** (`src/sse/emitter.ts`) — global singleton (`sseEmitter`) that maps `deviceId → SSE connection` and `runId → Set<deviceId>`. Manages connection lifecycle, backpressure-aware buffering, and event sequencing (reasoning → final → run-complete phases).

4. **Conversation history** (`src/conversation-history.ts`) — in-memory Map + JSON file persistence at `~/.openclaw/agents/main/sessions/friday-history/<sessionKey>.json`. Max 25 rounds per session, newest-first.

## Key Data Flows

### Message dispatch (POST /friday/messages → SSE response)
1. `messages.ts` validates auth + payload, writes `sessions.json` with `reasoningLevel: "stream"`, creates a history round
2. Dispatches to the agent via `dispatchReplyWithDispatcher()` with callbacks from `agent/runner.ts`
3. Callbacks (`onReasoningStream`, `onPartialReply`, etc.) broadcast events through `sseEmitter.broadcastToRun(runId, ...)`
4. On completion/error, `notifyRunComplete` or `notifyRunError` sends `run-complete`/`run-error`, then `untrackRun`
5. `POST /friday/messages` sets `CommandAuthorized: true` and `Provider: "friday"` on the dispatch context (after Bearer auth) so OpenClaw does not silently ignore whole-message `/new`, `/reset`, and other text commands; slash lines still use `CommandSource: "native"` when they start with `/`

### Device ID resolution for tool hooks
Tool hooks in `index.ts` (`before_tool_call`, `after_tool_call`) receive a `runId` but no `deviceId`. Resolution order:
1. `sseEmitter.getDeviceIdByRunId(runId)` — looks up registered run→deviceId mapping
2. `deviceIdFromSessionKey(sessionKey)` — parses `friday-{deviceId}` or legacy `agent:main:friday-{deviceId}` as fallback

### Session key canonicalization
`sessionKey` on `POST /friday/messages` is **required** and passed through verbatim (no plugin rewriting). History and `sessions.json` use the same string. If the value is rejected by OpenClaw (`validateSessionId`, e.g. keys with `:`), the app must choose a different id or the core must change — the plugin does not transform it. `toSessionStoreKey()` for `sessions.json`: bare keys as-is; `"main"` → `"agent:main:main"`.

## Important Implementation Notes

- **HTML vs SSE**: If a client sees `text/html` on `/friday/events`, the request missed plugin routing (SPA fallback). Common cause: `channels.friday` in `openclaw.json` was **only** `{ "enabled": true }` — OpenClaw ignores that for startup channel load unless there is **at least one non-`enabled` key** (e.g. `"transport": "http+sse"`). Also check wrong path (`/friday/message` vs `/friday/messages`) and gateway restart.
- **No build step**: The plugin is TypeScript source loaded by the gateway's TypeScript runtime. No `tsc`, no bundler.
- **Singleton emitter**: `sseEmitter` in `src/sse/emitter.ts` is a global singleton — do not create multiple instances.
- **Phase sequencing**: The SSE emitter tracks `reasoningStarted/Ended` and `finalStarted/Ended` per run to inject `phase: "start"/"end"` markers. Never send duplicate phase markers for the same run.
- **`flushNow` for final text**: `onPartialReply` calls `broadcastToRun` with `flushNow=true` to bypass the 16ms batch timer for real-time streaming feel.
- **`setImmediate` for run cleanup**: `notifyRunComplete` uses `setImmediate` before `untrackRun` to ensure the `run-complete` SSE event flushes before closing the socket.
- **Bearer token auth**: All HTTP routes use `auth: "plugin"` with token validated via `extractBearerToken()` against the gateway's configured `gateway.auth.token`.
- **Files stored in OpenClaw media buffer**: `~/.openclaw/media/inbound/<uuid>`. File IDs may include extensions (e.g., `abc123.png`).
