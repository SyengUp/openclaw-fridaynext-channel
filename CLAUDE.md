# CLAUDE.md

Guidance for working in this repository (OpenClaw `friday-next` channel plugin).

## Commands

```bash
pnpm build           # Compile TS to dist/ (required before gateway restart)
./cli.mjs           # One-click: install deps, build, and configure OpenClaw
pnpm test:unit       # Vitest unit tests (excludes *.e2e.test.ts)
pnpm test:e2e        # Vitest e2e (vitest.e2e.config.ts)
pnpm test            # unit then e2e
pnpm test:smoke      # Live gateway smoke (optional, needs running gateway)
pnpm test:msg-live   # Live message roundtrip (needs running gateway)

# Run a single test file
pnpm vitest run src/http/handlers/messages.test.ts
pnpm vitest run --config vitest.e2e.config.ts src/e2e/send-text.e2e.test.ts
```

Tests use a vitest `openclaw` import alias that resolves to `~/Downloads/openclaw-<version>/src` (configured in `vitest.config.ts`).

## Architecture

### Data flow

```
iOS App ←--HTTP/SSE--→ Friday Plugin ←--OpenClaw Plugin API--→ Gateway + Agent
                            │
                       [sseEmitter] — broadcasts events to connected devices
                            │
                    [offline-queue] — JSONL per-device persistence for replay
```

1. **`index.ts`** — Plugin entry. Registers HTTP routes, `onAgentEvent` → `forwardAgentEventRaw`, and tool hooks (`before_tool_call`/`after_tool_call` → `tool-hook` SSE). Uses Symbol-keyed dedupe guards (one route registration and one hook registration per process).
2. **`src/channel.ts`** — Plugin channel definition; `sendText` / `sendMedia` → `sseEmitter.broadcast(..., type: "outbound")` (plus media URL handling).
3. **`src/http/server.ts`** + **`src/http/handlers/*`** — `/friday-next/*` routes (no `/history`).
4. **`src/sse/emitter.ts`** — Singleton: connections, per-device monotonic SSE ids, `broadcast` / `broadcastToRun`, integrates **`src/sse/offline-queue.ts`** (JSONL writes before socket write; `connected` events are NOT persisted).
5. **`src/friday-session.ts`** — `deviceId` ↔ `sessionKey` mapping; **`forwardAgentEventRaw`** handles thinking delta rewriting, lifecycle metadata merging, and terminal lifecycle deferral (for session store flush).
6. **`src/agent/dispatch-bridge.ts`** — `runFridayDispatch`; test mock via `__setMockFridayDispatchForTests`.
7. **`src/agent/active-runs.ts`** — Lifecycle-derived `activeRuns` for **`GET /status`**.
8. **`src/config.ts`** + **`src/runtime.ts`** + **`src/host-config.ts`** — Config resolution chain: runtime store → `loadConfig()` → `channels["friday-next"]` with defaults/bounds. Tests inject config via `setMockRuntime`.
9. **`src/run-metadata.ts`** — Per-run in-memory metadata (model name, tokens, context window) extracted from agent events.
10. **`src/session/session-manager.ts`** — Session level persistence (`reasoningLevel`/`thinkingLevel`) in `sessions.json`, session key normalization.

## SSE event names

`connected` | `agent` | `deliver` | `tool-hook` | `outbound` | `ping`

Do not reintroduce `run-start` / `run-complete` / `run-error` / `final` / `reasoning` / `block` / `attachment` / `tts` as top-level SSE events.

## Message flow (`POST /messages`)

Validate auth → `ensureSessionLevels` / session mapping → `runFridayDispatch` with `deliver` → `deliver` SSE (+ URL translation); errors → `outbound` `dispatch_error`. No plugin-side conversation history.

`ensureSessionLevels` writes `reasoningLevel` and `thinkingLevel` into `~/.openclaw/agents/main/sessions/sessions.json` keyed by the normalized session key (`"agent:main:<raw>"`).

## Tool hook flow

`before_tool_call` / `after_tool_call` → resolve device ID (runId → sessionKey → sole connected device → last registered) → `broadcastToolEvent(type: "tool-hook", ...)` sent only to the owning device. Each hook fires a console.error log line prefixed `[Friday-HOOK]` for debugging.

## Config (`src/config.ts`)

From `channels["friday-next"]`: `authToken`, `historyDir` (default `~/.openclaw/friday-next/history`), `sse.backlogPerDevice`, `sse.keepaliveSec`, CORS fields. Offline queue dir: `dirname(historyDir) + "/events-queue"`.

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
