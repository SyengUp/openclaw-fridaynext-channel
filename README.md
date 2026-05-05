# Friday Next Channel Plugin

`friday-next` is an OpenClaw channel plugin for Apple apps (iOS/macOS) using HTTP + standard SSE.

## Features

- Channel id: `friday-next` (alongside legacy `friday` if configured)
- **Transparent proxy SSE**: forwards OpenClaw `onAgentEvent` as `event: agent`, dispatch `deliver` as `event: deliver`, tool hooks as `event: tool-hook`, channel pushes as `event: outbound`
- **Single synthetic event**: `connected` (`deviceId`, `serverTime`, `lastSeq`)
- **Disk-backed SSE replay** per `deviceId` (JSONL + `Last-Event-ID` / `lastEventId`) for offline gaps and restarts
- File upload/download (`POST /friday-next/files`, `GET /friday-next/files/:id`)
- Cancel (`POST /friday-next/cancel`) and status with `activeRuns` (`GET /friday-next/status`)

## Endpoints

- `GET /friday-next/events?deviceId=...`
- `POST /friday-next/messages`
- `POST /friday-next/files`
- `GET /friday-next/files/:id`
- `POST /friday-next/cancel`
- `GET /friday-next/status`

See **`API.md`** (English) and **`API.zh-CN.md`** (Chinese) for payloads, event shapes, offline queue paths, and breaking changes.

## Testing

- `pnpm test:unit` — Vitest unit tests (excludes `*.e2e.test.ts`)
- `pnpm test:e2e` — in-process app simulator (`vitest.e2e.config.ts`)
- `pnpm test` — `test:unit` then `test:e2e`
- `pnpm test:smoke` — optional live gateway smoke (gateway running; token from env or config)

## Migration

- There is **no** `GET/DELETE /friday-next/history`; clients must reconstruct state from SSE.
- Legacy SSE names (`final`, `run-start`, `run-complete`, `run-error`, `reasoning`, `attachment`, `tts`, `block`, …) are **not** emitted; use `agent` + `deliver` + `tool-hook` + `outbound`.
