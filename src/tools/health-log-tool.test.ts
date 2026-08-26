import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { sseEmitter } from "../sse/emitter.js";
import { setMockRuntime } from "../test-support/mock-runtime.js";
import { createHealthLogTool, HEALTH_LOG_TOOL_NAME } from "./health-log-tool.js";
import { resolveHealthQueryResult } from "../health-query/pending-store.js";

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

describe("createHealthLogTool", () => {
  beforeEach(() => {
    setMockRuntime();
  });

  afterEach(() => {
    sseEmitter.resetForTest();
  });

  it("exposes write-only metrics", () => {
    const tool = createHealthLogTool({ sessionKey: "agent:main:s1" });
    expect(tool.name).toBe(HEALTH_LOG_TOOL_NAME);
    expect(tool.description).toContain("Write samples");
    expect(tool.parameters.properties.samples.items.properties.metric.enum).toContain("dietaryCaffeine");
    expect(tool.parameters.properties.samples.items.properties.metric.enum).not.toContain("sleep");
  });

  it("rejects empty samples without contacting the phone", async () => {
    const tool = createHealthLogTool({ sessionKey: "agent:main:s1" });
    const result = await tool.execute("call-1", { samples: [] });
    const parsed = JSON.parse(result.content[0].text) as { error: { code: string } };
    expect(parsed.error.code).toBe("HEALTH_INVALID_SAMPLE");
  });

  it("broadcasts fridaynext-health-log and returns the POST payload", async () => {
    const res = new MockRes();
    sseEmitter.addConnection("PHONE-1", res as never);
    const tool = createHealthLogTool({ sessionKey: "agent:main:s1" });
    const pending = tool.execute("call-2", {
      samples: [{ metric: "dietaryEnergy", value: 520, unit: "kcal" }],
    });
    await vi.waitFor(() => {
      expect(res.writes.join("")).toContain("event: fridaynext-health-log");
    });
    const frame = res.writes.join("");
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    expect(dataLine).toBeTruthy();
    const data = JSON.parse(dataLine!.slice("data: ".length)) as { requestId: string };
    expect(
      resolveHealthQueryResult(data.requestId, {
        ok: true,
        payload: { saved: [{ metric: "dietaryEnergy", value: 520 }] },
      }),
    ).toBe(true);
    const result = await pending;
    const parsed = JSON.parse(result.content[0].text) as {
      saved: Array<{ metric: string }>;
    };
    expect(parsed.saved[0].metric).toBe("dietaryEnergy");
  });
});
