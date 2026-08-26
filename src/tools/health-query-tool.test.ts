import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { sseEmitter } from "../sse/emitter.js";
import { setMockRuntime } from "../test-support/mock-runtime.js";
import { createHealthQueryTool, HEALTH_QUERY_TOOL_NAME } from "./health-query-tool.js";
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

describe("createHealthQueryTool", () => {
  beforeEach(() => {
    setMockRuntime();
  });

  afterEach(() => {
    sseEmitter.resetForTest();
  });

  it("exposes a namespaced name and when-to-call description", () => {
    const tool = createHealthQueryTool({ sessionKey: "agent:main:s1" });
    expect(tool.name).toBe(HEALTH_QUERY_TOOL_NAME);
    expect(tool.description).toContain("HealthKit");
    expect(tool.description).toContain("nodes.device_health");
    expect(tool.parameters.properties.metrics.items.enum).toContain("steps");
    expect(tool.parameters.properties.metrics.items.enum).toContain("dietaryCaffeine");
    expect(tool.parameters.properties.metrics.items.enum).toContain("basalEnergy");
  });

  it("returns HEALTH_DEVICE_OFFLINE when SSE is down", async () => {
    const tool = createHealthQueryTool({ sessionKey: "agent:main:s1" });
    const result = await tool.execute("call-1", {});
    const parsed = JSON.parse(result.content[0].text) as {
      error: { code: string };
    };
    expect(parsed.error.code).toBe("HEALTH_DEVICE_OFFLINE");
  });

  it("broadcasts fridaynext-health-query and returns the POST payload", async () => {
    const res = new MockRes();
    sseEmitter.addConnection("PHONE-1", res as never);
    const tool = createHealthQueryTool({ sessionKey: "agent:main:s1" });
    const pending = tool.execute("call-2", { metrics: ["steps"], bucket: "day" });
    await vi.waitFor(() => {
      expect(res.writes.join("")).toContain("event: fridaynext-health-query");
    });
    const frame = res.writes.join("");
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    expect(dataLine).toBeTruthy();
    const data = JSON.parse(dataLine!.slice("data: ".length)) as { requestId: string };
    expect(resolveHealthQueryResult(data.requestId, { ok: true, payload: { metrics: { steps: 3 } } })).toBe(
      true,
    );
    const result = await pending;
    const parsed = JSON.parse(result.content[0].text) as { metrics: { steps: number } };
    expect(parsed.metrics.steps).toBe(3);
  });
});
