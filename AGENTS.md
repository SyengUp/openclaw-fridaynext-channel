# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

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
pnpm lint            # ESLint (type-aware); baseline is 0 errors / ~241 warnings
pnpm lint:fix        # ESLint with --fix
pnpm format          # Prettier write all files
pnpm format:check    # Prettier check only (CI-friendly)

# Run a single test file
pnpm vitest run src/http/handlers/messages.test.ts
pnpm vitest run --config vitest.e2e.config.ts src/e2e/send-text.e2e.test.ts
```

Both vitest configs auto-detect the OpenClaw dist directory from standard install paths (`/opt/homebrew`, `/usr/local`, nvm). If your OpenClaw is installed elsewhere, set the `OPENCLAW_DIST` env var or update the candidates in both configs.

### Local dev against a running gateway

The gateway loads the plugin from `~/.openclaw/npm/node_modules/@syengup/friday-channel-next`, which `openclaw plugins install` populates as a **copy** by default — so edits to this repo do NOT take effect even after `pnpm build` + restart (requests to new routes fall through to the gateway's SPA catch-all and return Control UI HTML instead of JSON). Link the repo once so the gateway loads this working tree directly:

```bash
openclaw plugins install . --link    # symlink dev dir (cannot combine with --force; replaces any existing copy)
```

After that, the iterate loop is just: `pnpm build` → `openclaw gateway restart`. Verify a route returns JSON (not HTML), e.g. `curl -s -H "Authorization: Bearer <token>" http://127.0.0.1:<port>/friday-next/agents`. Port + token come from `~/.openclaw/openclaw.json` (`gateway.port`, `gateway.auth.token`).

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
   - `POST /friday-next/nodes-approve` — node pairing approval (`handleNodesApprove`)
   - `PUT|GET /friday-next/sessions/settings` — read/write session settings (`handleSessionsSettings`)
   - `GET /friday-next/models` — list available models (`handleModelsList`)
   - `GET /friday-next/agents` — list configured agents (`handleAgentsList`); returns `{ ok, agents, defaultAgentId }` where each agent has `id`/`name`/`description`/`model`/`thinkingDefault`/`isDefault`/`emoji`/`avatar`. Reads `cfg.agents.list` directly from the runtime config (same pattern as models-list, not via gateway dispatch); falls back to a single implicit `main` agent when none are configured.
   - `GET|PUT /friday-next/agents/{id}/config` — read/edit one agent's config (`handleAgentConfig`): `model`/`thinkingDefault`/`tools`/`skills` + discovered `availableSkills`. PUT is a partial patch (explicit `null` clears a field → inherits `agents.defaults`); writes via `api.runtime.config.mutateConfigFile` (`afterWrite: { mode: "auto" }`, in-place draft mutation → hot-reload). Implicit `main` with no list entry gets a bare `{id}` created (never `default: true`).
   - `GET /friday-next/agents/{id}/files` · `GET|PUT /friday-next/agents/{id}/files/{name}` — list/read/write the agent's whitelisted core `.md` workspace files (`handleAgentFiles`): `AGENTS/IDENTITY/SOUL/TOOLS/MEMORY/USER/HEARTBEAT/BOOTSTRAP.md`. Direct fs write into `resolveAgentWorkspaceDir(cfg, id)` (main → workspace root; others → `workspace/agents/{id}`), traversal-guarded, 256 KiB cap, no restart.
   - `GET /friday-next/agents/{id}/tools/catalog` — full tool catalog for the toolbox editor (`handleAgentToolsCatalog`): core + plugin tools grouped by category, with descriptions, the 4 profiles (minimal/coding/messaging/full), and per-tool `enabled`/`inProfile`. Built from core's `buildToolsCatalogResult`.
   - `GET /friday-next/status` — active runs + connection count (`handleStatus`)
   - `GET /friday-next/health` — node-pairing health + optional self-heal (`handleHealth`; query: `deviceId`, `nodeDeviceId`, `selfHeal`)
   - `GET /friday-next/history/sessions` · `GET /friday-next/history/messages` · `PUT|POST /friday-next/sessions/title` — history sync (list sessions across agents, read a session's messages, sync app title → server `displayName`).
   - `GET /friday-next/link-preview?url=...` — Open Graph metadata for link-preview cards.
   - `GET /friday-next/plugin/info` · `POST /friday-next/plugin/upgrade` — self-version report + in-process npm upgrade & safe restart (npm installs only; dev/`--link` installs return 409).
   - `POST /friday-next/device-approve` · `POST /friday-next/nodes-approve` — device/node pairing approval.

   The single registered route (`path: "/friday-next"`, `match: "prefix"`, `auth: "plugin"`) is dispatched by `handleFridayNextRoute` via method+pathname checks; the plugin does its own bearer auth. The `/friday-next/agents/{id}/...` subpaths are parsed segment-wise in `server.ts`.
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
16. **`src/http/handlers/files.ts`** — Central file store: `attachments/` directory under plugin root, in-memory index, `storeFile`/`readFile`/`resolveMediaUrl`/`resolveMediaAttachment`. Handles `file://` URI resolution and `~/` expansion for agent-provided paths. The HTTP route handlers are split out: **`files-upload.ts`** (`handleFilesUpload`, multipart `POST`) and **`files-download.ts`** (`handleFilesDownload`, `GET /files/:id`).
17. **`src/agent/run-usage-accumulator.ts`** — Per-`runId` token-usage accumulator fed by the `llm_output` hook (`accumulateRunUsage`). `consumeRunUsage(runId)` drains it into a `FridaySessionUsagePayload` (with `tokens.totalFresh`) for terminal lifecycle frames.
18. **`src/agent/abort-run.ts`** — `abortRun(runId)` dynamically imports `openclaw/plugin-sdk/agent-harness` and calls `abortAgentHarnessRun`; backs `POST /cancel`. No-op under Vitest.
19. **`src/agent/node-pairing-bridge.ts`** — `loadNodePairingModule` lazy-loads OpenClaw's node-pairing module. Resolves the OpenClaw `dist/` cross-platform: `OPENCLAW_DIST` env → walk `PATH` for the `openclaw` binary → `realpathSync` → `dist/` → platform-standard install paths. Backs `GET /health` and `POST /nodes-approve`.

### Supporting modules

- **`src/channel-actions.ts`** — `describeMessageActions` / `handleMessageAction` for the channel's message-tool integration (`send`, `channel-info`, `channel-list`).
- **`src/friday-inbound-stats.ts`** — Tracks last `POST /messages` timestamp for Control UI channel health display.
- **`src/logging.ts`** — Scoped logger factory (`[friday-next:<scope>]` prefix, level-gated).
- **`src/vendor/runtime-store.ts`** — Vendored from OpenClaw SDK; `Symbol.for("openclaw.plugin-sdk.runtime-store-registry")`-based runtime singleton. Kept here to avoid importing the full gateway graph in tests.
- **`src/openclaw.d.ts`** — Ambient module declarations for `openclaw/plugin-sdk/*` imports (avoids depending on the full SDK type bundle).
- **`src/collect-message-media-paths.ts`** — Extracts local filesystem paths (`/Users/.../file.ext`, `mediaUrl`, `filePath`, `audioPath`) from tool result JSON/strings. Used by outbound media delivery to resolve agent-generated files.
- **`openclaw.plugin.json`** — Plugin manifest declaring channel metadata, config schema (auth token, CORS, SSE keepalive/backlog), UI hints (sensitive fields), and env vars (`FRIDAY_NEXT_AUTH_TOKEN`).

### Agent config editing (`/friday-next/agents/{id}/…`)

Lets the app edit a single agent the way ControlUI does — model / core files / tool permissions / skills — entirely through the plugin's own config + workspace access, **zero OpenClaw core changes** (config edits land in `agents.list[]` via `mutateConfigFile`; files write straight to the workspace).

- **`src/agent-id.ts`** — shared `normalizeAgentId` (mirrors core's session-key agent-id rule); used by `agents-list`, the config/files/tools handlers, and discovery. Empty → `main`.
- **`src/http/handlers/agent-config.ts`** — `GET|PUT …/config`. Reads the `agents.list[]` entry; PUT applies a partial patch (null = delete key). Writes go through `getUpgradeRuntime().mutateConfigFile`.
- **`src/http/handlers/agent-files.ts`** — `GET|PUT …/files[/{name}]`. Whitelisted core `.md` files via `resolveAgentWorkspaceDir` + Node fs.
- **`src/skills-discovery.ts`** — `discoverAvailableSkills(cfg, agentId)` returns `{ id, source, description }[]` by **scanning the same dirs core scans** (core's skill-discovery is only in hash chunks, not a stable plugin-sdk export — but skills are directory data, so we scan instead of deep-import). Sources: `workspace` (agent + shared default-agent `skills/`), `installed` (`<configDir>/skills`), `extra` (enabled-extension `dist/extensions/<ext>/skills` + `skills.load.extraDirs`), `built-in` (`<openclaw>/skills`). id = `SKILL.md` frontmatter `name` (recursive). Extension skills gated by `enabledExtensionNames` (= `plugins.allow` ∪ `entries.enabled`) to match ControlUI. Also exports `resolveOpenClawRoot` (shared with tool-catalog).
- **`src/tool-catalog.ts`** + **`src/http/handlers/agent-tools-catalog.ts`** — `GET …/tools/catalog`. The tool catalog is **code, not scannable data**, so this **resilient-deep-imports** core's `buildToolsCatalogResult` (scan `<openclaw>/dist/*.js` for the chunk defining it → dynamic `import()` hits the gateway's already-loaded module instance, no side effects → cache; degrade to 503 on failure). Per-tool `enabled`/`inProfile` are resolved here from the agent's `tools` config so the app renders simple toggles and computes the allow/deny delta.

## SSE event names

`connected` | `agent` | `deliver` | `tool-hook` | `outbound` | `ping` | `subagent`

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

`handleHealth` checks node-pairing state for the given `deviceId`/`nodeDeviceId` against `REQUIRED_NODE_CAPS` (`location`, `canvas`) and `REQUIRED_NODE_COMMANDS` (location + canvas command set). With `selfHeal=true` it attempts repair actions (e.g. auto-approving a pending node) and reports each as a `RepairAction`. `handleNodesApprove` approves a pending node pairing request (scope-gated, returns `forbidden` with `missingScope` if not permitted). Both go through `node-pairing-bridge.ts`.

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
- **Lint policy** (`eslint.config.js`): keep `pnpm lint` at **0 errors**. The ~241 `no-unsafe-*` / `no-explicit-any` **warnings** are structural noise from the untyped OpenClaw host SDK (`openclaw.d.ts` is a hand-written `any` shim) — expected, not debt. `require-await` is off (HTTP handlers / SDK callbacks present async signatures by contract). `_`-prefixed names are intentionally-unused.
