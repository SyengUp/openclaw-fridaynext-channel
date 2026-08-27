import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { sseEmitter } from "../sse/emitter.js";
import { setMockRuntime } from "../test-support/mock-runtime.js";
import { createCalendarLogTool, CALENDAR_LOG_TOOL_NAME } from "./calendar-log-tool.js";
import {
  resolveCalendarResult,
  resetCalendarPendingStoreForTest,
} from "../calendar/pending-store.js";

vi.mock("../friday-session.js", () => ({
  resolveFridayDeviceIdForSessionKey: () => "PHONE-1",
  getLastRegisteredFridayDeviceId: () => "PHONE-1",
}));

class MockRes extends EventEmitter {
  writes: string[] = [];
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
  end(): void {
    // no-op
  }
}

describe("createCalendarLogTool", () => {
  beforeEach(() => {
    setMockRuntime();
  });

  afterEach(() => {
    sseEmitter.resetForTest();
    resetCalendarPendingStoreForTest();
  });

  it("exposes a namespaced name and routing-rich description", () => {
    const tool = createCalendarLogTool({ sessionKey: "agent:main:s1" });
    expect(tool.name).toBe(CALENDAR_LOG_TOOL_NAME);
    expect(tool.description).toContain('kind="event"');
    expect(tool.description).toContain('kind="reminder"');
    expect(tool.description).toContain("cron");
    expect(tool.description).toContain("fridaynext_calendar_query");
    expect(tool.description).toContain("nodes");
  });

  it("rejects malformed items with CALENDAR_INVALID_ITEM", async () => {
    const tool = createCalendarLogTool({ sessionKey: "agent:main:s1" });
    const result = await tool.execute("call-1", { items: [{ kind: "event" }] });
    const parsed = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(parsed.error.code).toBe("CALENDAR_INVALID_ITEM");
  });

  it("returns CALENDAR_DEVICE_OFFLINE when SSE is down", async () => {
    const tool = createCalendarLogTool({ sessionKey: "agent:main:s1" });
    const result = await tool.execute("call-2", {
      items: [{ kind: "event", title: "Dentist", start: "2026-08-28T09:00:00+08:00" }],
    });
    const parsed = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(parsed.error.code).toBe("CALENDAR_DEVICE_OFFLINE");
  });

  it("broadcasts fridaynext-calendar-log and returns the POST payload", async () => {
    const res = new MockRes();
    sseEmitter.addConnection("PHONE-1", res as never);
    const tool = createCalendarLogTool({ sessionKey: "agent:main:s1" });
    const pending = tool.execute("call-3", {
      items: [
        {
          kind: "event",
          title: "Dentist",
          start: "2026-08-28T09:00:00+08:00",
          alarmMinutesBefore: 15,
        },
        { kind: "reminder", title: "Submit report", dueDate: "2026-08-29", priority: "high" },
      ],
    });
    await vi.waitFor(() => {
      expect(res.writes.join("")).toContain("event: fridaynext-calendar-log");
    });
    const frame = res.writes.join("");
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    expect(dataLine).toBeTruthy();
    const data = JSON.parse(dataLine!.slice("data: ".length)) as {
      requestId: string;
      items: Array<{ kind: string; title: string }>;
    };
    expect(data.items).toHaveLength(2);
    expect(data.items[0]).toMatchObject({ kind: "event", title: "Dentist" });
    expect(data.items[1]).toMatchObject({ kind: "reminder", title: "Submit report" });
    expect(
      resolveCalendarResult(data.requestId, {
        ok: true,
        payload: { created: [{ kind: "event", title: "Dentist" }] },
      }),
    ).toBe(true);
    const result = await pending;
    const parsed = JSON.parse(result.content[0].text) as {
      created: Array<{ kind: string; title: string }>;
    };
    expect(parsed.created[0].title).toBe("Dentist");
  });
});
