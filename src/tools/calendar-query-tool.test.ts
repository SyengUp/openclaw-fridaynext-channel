import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { sseEmitter } from "../sse/emitter.js";
import { setMockRuntime } from "../test-support/mock-runtime.js";
import { createCalendarQueryTool, CALENDAR_QUERY_TOOL_NAME } from "./calendar-query-tool.js";
import { resetCalendarPendingStoreForTest } from "../calendar/pending-store.js";
import { resolveCalendarResult } from "../calendar/pending-store.js";

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

describe("createCalendarQueryTool", () => {
  beforeEach(() => {
    setMockRuntime();
  });

  afterEach(() => {
    sseEmitter.resetForTest();
    resetCalendarPendingStoreForTest();
  });

  it("exposes a namespaced name and routing-rich description", () => {
    const tool = createCalendarQueryTool({ sessionKey: "agent:main:s1" });
    expect(tool.name).toBe(CALENDAR_QUERY_TOOL_NAME);
    expect(tool.description).toContain("Calendar events and Reminders");
    expect(tool.description).toContain("cron");
    expect(tool.description).toContain("fridaynext_health_query");
    expect(tool.description).toContain("nodes");
  });

  it("returns CALENDAR_DEVICE_OFFLINE when SSE is down", async () => {
    const tool = createCalendarQueryTool({ sessionKey: "agent:main:s1" });
    const result = await tool.execute("call-1", {});
    const parsed = JSON.parse(result.content[0].text) as {
      error: { code: string };
    };
    expect(parsed.error.code).toBe("CALENDAR_DEVICE_OFFLINE");
  });

  it("broadcasts fridaynext-calendar-query and returns the POST payload", async () => {
    const res = new MockRes();
    sseEmitter.addConnection("PHONE-1", res as never);
    const tool = createCalendarQueryTool({ sessionKey: "agent:main:s1" });
    const pending = tool.execute("call-2", {
      kinds: ["events"],
      start: "2026-08-27T00:00:00+08:00",
    });
    await vi.waitFor(() => {
      expect(res.writes.join("")).toContain("event: fridaynext-calendar-query");
    });
    const frame = res.writes.join("");
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    expect(dataLine).toBeTruthy();
    const data = JSON.parse(dataLine!.slice("data: ".length)) as {
      requestId: string;
      kinds: string[];
      start: string;
    };
    expect(data.kinds).toEqual(["events"]);
    expect(data.start).toBe("2026-08-27T00:00:00+08:00");
    expect(
      resolveCalendarResult(data.requestId, {
        ok: true,
        payload: { events: [{ title: "Team sync" }] },
      }),
    ).toBe(true);
    const result = await pending;
    const parsed = JSON.parse(result.content[0].text) as {
      events: Array<{ title: string }>;
    };
    expect(parsed.events[0].title).toBe("Team sync");
  });
});
