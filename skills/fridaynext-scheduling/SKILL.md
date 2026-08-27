---
name: fridaynext-scheduling
description: "Choose the right time mechanism on the user's iPhone: cron (the agent schedules its own future or recurring work), FridayNext Calendar events (meetings/appointments that occupy time), or FridayNext Reminders (to-dos with at most a deadline). Load this before creating any event, reminder, or scheduled task for the user."
---

# FridayNext Scheduling: cron vs Calendar vs Reminders

When the user asks for anything time-related, pick the mechanism by **what they actually want**, not by the verb they used.

## Decision table

| What the user wants | Mechanism | Tool |
|---|---|---|
| Something that occupies a time range or happens at a time: meetings, appointments, classes, flights, doctor visits | iPhone Calendar event (+ alarm) | `fridaynext_calendar_log` with `kind: "event"` |
| Something to *do*, with at most a deadline: buy groceries, reply to email, submit a report, to-do lists | iPhone Reminder (+ dueDate + alarm) | `fridaynext_calendar_log` with `kind: "reminder"` |
| The agent itself must act later or on a schedule: "check the deployment in 2 hours", "daily summary every morning", delayed follow-ups, recurring patrols | OpenClaw scheduled task | built-in `cron` tool |
| Reading the schedule: "what's on today", "am I free Thursday", "what's due this week" | Read Calendar + Reminders | `fridaynext_calendar_query` |

## The "remind me" rule (提醒我)

Classify the **object** of the sentence, not the verb "remind":

- Object is an activity that occupies time, or has attendees / a location (开会 meeting, 上课 class, 看医生 doctor, 面试 interview) → **Calendar event** at that time; the "remind" part is `alarmMinutesBefore` (suggest 15).
- Object is an action with no duration (交报告 submit report, 打电话 call back, 买东西 buy) → **Reminder** with `dueDate` and an alarm.
- The requested reminder is for *Friday itself* to do something (查部署 check deploy, 发总结 send summary) → **cron**.

Examples:

- 提醒我明天 9 点开会 / "remind me of the 9am meeting tomorrow" → Calendar **event** at 9:00 + alarm 15.
- 提醒我明天 9 点前交报告 / "remind me to submit the report before 9 tomorrow" → **Reminder** dueDate 明天 9:00 + alarm.
- 明天 9 点帮我查一下天气发给我 / "at 9 tomorrow check the weather and send it to me" → **cron** (the agent must wake up and act).

## Field cheatsheet

- Events: `start` (ISO-8601 with timezone; `allDay` events accept bare `YYYY-MM-DD`), `end` defaults to start + 1 hour (all-day: next day), optional `location`, `notes`.
- Reminders: optional `dueDate` (ISO-8601 or bare date — omit only if the user gave no time at all), optional `priority` (none/low/medium/high).
- `alarmMinutesBefore` (0 = none, max 20160 = 14 days) applies to **both** kinds — this is how you honor "remind me".
- No recurrence in v1. Recurring *agent* work → cron. A recurring *human* commitment (weekly class) → one event at a time; do not invent recurrence.

## Constraints

- New events/reminders land in the user's chosen **default calendar / default reminder list** (set in FridayNext → Calendar & Reminders). Never ask which calendar; never claim you picked one.
- The app only creates and reads — it never modifies or deletes existing events or completes reminders.
- Requires the user to enable sharing in FridayNext → Calendar & Reminders, plus the iOS Calendar/Reminders permission. If the tool returns `CALENDAR_DISABLED` / `CALENDAR_WRITE_DISABLED`, tell the user to enable it there — do not retry.
- The phone must be online on the Friday SSE channel; `CALENDAR_DEVICE_OFFLINE` means it isn't.
- When unsure: personal to-do → Reminder; anything with attendees, duration, or a location → Calendar event; anything that needs the agent to wake up → cron. If the user explicitly says 日历/日程 → Calendar; 提醒事项/待办 → Reminders.
