import { describe, expect, it } from "vitest";
import {
  shouldHideNotification,
  type CronNotificationMetadata,
} from "./notification-visibility.js";

const cronMetadata = new Map<string, CronNotificationMetadata>([
  ["heartbeat-job", { name: "heartbeat-main", isSystemHeartbeat: true }],
  ["daily-job", { name: "每日科技", isSystemHeartbeat: false }],
]);

describe("shouldHideNotification", () => {
  it("hides direct legacy heartbeat rows", () => {
    expect(
      shouldHideNotification(
        { kind: "heartbeat", sourceSessionKey: "agent:main:main:heartbeat" },
        cronMetadata,
      ),
    ).toBe(true);
  });

  it("hides rows historically misattributed to the system heartbeat cron", () => {
    expect(
      shouldHideNotification(
        { kind: "cron", sourceSessionKey: "", jobId: "heartbeat-job" },
        cronMetadata,
      ),
    ).toBe(true);
  });

  it.each([
    "First heartbeat alert: your bot runs periodic background checks and messages you only when something needs attention.",
    "⚠️ Heartbeat check failed before it could produce an update. The main chat session remains available.",
  ])("hides OpenClaw-authored legacy heartbeat envelope: %s", (text) => {
    expect(
      shouldHideNotification(
        { kind: "push", sourceSessionKey: "agent:main:fridaynext:device", text },
        cronMetadata,
      ),
    ).toBe(true);
  });

  it("does not hide ordinary user content merely because it mentions heartbeat", () => {
    expect(
      shouldHideNotification(
        {
          kind: "push",
          sourceSessionKey: "agent:main:fridaynext:device",
          text: "请帮我解释 heartbeat 的实现",
        },
        cronMetadata,
      ),
    ).toBe(false);
  });

  it("preserves real scheduled-task notifications", () => {
    expect(
      shouldHideNotification(
        { kind: "cron", sourceSessionKey: "", jobId: "daily-job" },
        cronMetadata,
      ),
    ).toBe(false);
  });
});
