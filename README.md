# FridayNext — OpenClaw iOS Channel & Node

OpenClaw iOS channel & node — FridayNext turns your iPhone into a full OpenClaw client.
It streams every answer live, shows you the thinking behind it, and keeps your agent one tap
away — anywhere you go.

[<img src="assets/download-on-the-app-store.png" width="120" alt="Download on the App Store">](https://apps.apple.com/us/app/fridaynext/id6768689875)

---

## Why FridayNext

**Your agent, not a stranger's.** FridayNext talks to *your own* OpenClaw gateway. Self-hosted
and private by default — your conversations, your data, your rules. No middleman, no lock-in.

**Watch it think.** Answers stream in real time with the agent's reasoning, tool calls, and
subagent work laid out as they happen. You don't just get the result — you see how it got
there, and you can jump in at any moment.

**More than chat.**

| Feature | Why |
| --- | --- |
| 🎨 **Interactive canvas** | Your agent pushes live web content, dashboards, and interactive UIs right into the conversation. |
| ⏰ **Scheduled tasks** | Set recurring jobs from your phone and let your agent work on a schedule. |
| 🔔 **Proactive notifications** | Your agent reaches out when something needs you — right in your notification inbox. |
| 📎 **Share anything** | Send links, text, photos, and files to your agent straight from the iOS share sheet. |
| 🔊 **Listen to answers** | Built-in text-to-speech reads responses aloud while you're on the move. |
| 🌍 **Reach it anywhere** | Optional FridayTunnel relay keeps you connected to your gateway when you're away from home. |
| 🗂️ **Organize your AI** | Multiple agents, multiple servers, per-agent settings, and history that syncs across your devices. |
| 🖼️ **Beautiful by design** | A native iOS experience built for speed and elegance — from the first message to the last. |

## A glimpse inside

<p align="center">
  <img src="assets/screenshots/glimpse.png" width="1055" alt="FridayNext screenshots — home, native markdown, transparent reasoning & tools, interactive canvas, and agent management">
</p>

<p align="center"><em>Your agents, your chats, your tools — all in one place.</em></p>

## Download

[<img src="assets/download-on-the-app-store.png" width="120" alt="Download on the App Store">](https://apps.apple.com/us/app/fridaynext/id6768689875)

Available now on the App Store for iPhone. Free to download.

---

## What's this package?

`@syengup/friday-channel-next` is the OpenClaw side of FridayNext: a channel plugin that
connects the app to your own OpenClaw gateway. Install it once, pair your iPhone, and your
agent is in your pocket — with your phone acting as an OpenClaw **channel and node**, so your
agent can reach your canvas, location, and interactive UI from anywhere.

```bash
curl -fsSL https://gw.syengup.host/v1/friday-next/install.sh | sh
```

Then open FridayNext and follow the in-app setup — no command line required after that.

## Links

- **Download the app:** <https://apps.apple.com/us/app/fridaynext/id6768689875>
- **OpenClaw:** <https://openclaw.ai>
- **Plugin source:** <https://github.com/SyengUp/openclaw-fridaynext-channel>

---

*For developers: the plugin's API contract lives in [`API.md`](API.md) and
[`API.zh-CN.md`](API.zh-CN.md).*
