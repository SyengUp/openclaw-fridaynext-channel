---
summary: "FridayNext iOS channel overview, features, and configuration"
read_when:
  - You want to connect the FridayNext iOS app
  - You are configuring the FridayNext channel
title: FridayNext (iOS)
---

FridayNext is a native iOS app that turns your iPhone into a full OpenClaw client. The
community-maintained `@syengup/friday-channel-next` plugin connects the app to your own
OpenClaw gateway over HTTP + SSE: your phone acts as a **channel** (chat, share sheet, voice,
notifications, and location/calendar/Health tools). The OpenClaw **node** surface (canvas,
location, interactive UI) is a legacy-compat service retained for un-upgraded clients;
current app builds are HTTP + SSE only and do not dial it.

**Status:** production-ready for direct messages and interactive sessions. Self-hosted by
design — the app talks only to your own gateway; no middleman. This plugin is maintained by
its author (SyengUp) as an external catalog entry, not by core OpenClaw; the config/behavior
details below come from the plugin's own docs and are not verified against OpenClaw core
source.

## Quick start

First-time install is a single command — the package's own installer detects your OpenClaw,
installs the channel plugin, and enables it (including the canvas capability):

```bash
npx -y @syengup/friday-channel-next@beta --beta
```

One command for every platform (macOS, Linux, native Windows) — the installer probes
npmjs.org vs npmmirror itself and installs from the faster one. The `@beta` line is
pinned because Windows support currently ships only on the beta dist-tag (the stable
installer dies with `未找到 openclaw` on native Windows); drop `@beta --beta` once a
stable release carries the win32 support.

In mainland China, `npx` fetching the installer from registry.npmjs.org can hang; the
bootstrap scripts probe first and pick the mirror for you:

```bash
curl -fsSL https://gw.syengup.host/v1/friday-next/install.sh | sh -s -- --beta
```

```powershell
iex "& { $(iwr -useb https://gw.syengup.host/v1/friday-next/install.ps1) } -Beta"
```

Then open FridayNext on your iPhone and follow the in-app setup to pair with your gateway.
The installer restarts the gateway automatically — no manual restart needed.

**Upgrades:** once installed, later plugin updates are handled inside the FridayNext app —
no command line needed.

```bash
openclaw gateway restart
```

- **App:** <https://apps.apple.com/us/app/fridaynext/id6768689875> (free)
- **Plugin source:** <https://github.com/SyengUp/openclaw-fridaynext-channel>
- **API contract:** [API.md](https://github.com/SyengUp/openclaw-fridaynext-channel/blob/main/API.md)

## What you get

| Feature | Why |
| --- | --- |
| 🎨 Interactive canvas | Agents push live web content, dashboards, and interactive UIs into the conversation. |
| ⏰ Scheduled tasks | Create recurring jobs from your phone; the agent works on a schedule. |
| 🔔 Proactive notifications | Agents reach out through the iOS notification inbox. |
| 📎 Share sheet | Send links, text, photos, and files to your agent from anywhere in iOS. |
| 🔊 Text-to-speech | Listen to answers while on the move. |
| 🗂️ Multi-agent | Multiple agents and servers, per-agent settings, synced history. |
| 🌍 FridayTunnel | Optional relay keeps the phone connected to your gateway away from home. |

## Configuration

Basic setup (defaults are fine for most installs):

```json5
{
  channels: {
    "friday-next": {
      enabled: true,
      logLevel: "info", // "debug" | "info" | "warn" | "error"
    },
  },
}
```

| Setting | Description | Default |
| --- | --- | --- |
| `channels.friday-next.enabled` | Enable/disable the channel | `true` |
| `channels.friday-next.logLevel` | Verbosity of the plugin's gateway logs; raise to `debug` when reporting an issue | `info` |

## Supported message types

**Receive:** text, links, photos, files (via iOS share sheet and in-app input).

**Send:** text with live streaming (SSE), reasoning/tool-call transparency, canvas content,
interactive cards, proactive notifications, audio via built-in TTS.

**Pairing and access control:** the app authenticates against your own gateway; DM pairing
and allowlist policies follow OpenClaw's standard pairing flow. See [Pairing](/channels/pairing).

## Related

- [Channels Overview](/channels) - all supported channels
- [Pairing](/channels/pairing) - DM authentication and pairing flow
- [Security](/gateway/security) - access model and hardening
