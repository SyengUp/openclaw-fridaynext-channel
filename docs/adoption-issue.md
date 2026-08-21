# Title: Add FridayNext (iOS) as a documented external channel

## Summary

FridayNext is a native iOS app that turns an iPhone into a full OpenClaw client
(channel + node). Its companion plugin `@syengup/friday-channel-next` is published on
ClawHub and working in production. I'd like to add it to the supported channels docs as an
**external plugin** entry, alongside WeChat / Yuanbao / Zalo ClawBot.

- ClawHub: https://clawhub.ai/syengup/plugins/friday-channel-next
- Source: https://github.com/SyengUp/openclaw-fridaynext-channel
- App Store: https://apps.apple.com/us/app/fridaynext/id6768689875
- Install: `npx -y @syengup/friday-channel-next`

## Proposed changes

1. Add a row to `docs/channels/index.md`:
   - **FridayNext (iOS)** — Native iOS client; your phone as an OpenClaw channel & node
     (external plugin).
2. Add `docs/channels/friday-next.md` (draft attached in this issue / PR) covering:
   quick start, features, config reference, supported message types, pairing.

## Why this is useful

- FridayNext is a community-maintained native iOS client with a polished App Store experience. Documenting it gives iPhone users a
  one-command path (`npx -y @syengup/friday-channel-next`).
- The plugin is already live on ClawHub, passes the review/scan pipeline, and has a
  public repo, setup docs, and active maintenance (checklist per
  docs/plugins/community.md).

## Evidence / checklist

- [x] Published on ClawHub (install hints work)
- [x] Public GitHub repo (source review, issue tracking)
- [x] Setup and usage docs (README, API.md, API.zh-CN.md)
- [x] Active maintenance (recent releases; responsive issue handling)

Happy to open a PR with the two doc files, or adjust wording to match your conventions.
