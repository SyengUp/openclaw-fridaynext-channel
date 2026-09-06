import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { sseEmitter } from "../sse/emitter.js";
import { setMockRuntime } from "../test-support/mock-runtime.js";
import { getRuntimeV3Store } from "../runtime-v3/runtime-store.js";
import { createLocationQueryTool, LOCATION_QUERY_TOOL_NAME } from "./location-query-tool.js";
import { resolveLocationQueryResult } from "../location/pending-store.js";

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

describe("createLocationQueryTool", () => {
  beforeEach(() => {
    setMockRuntime();
  });

  afterEach(() => {
    sseEmitter.resetForTest();
  });

  it("exposes a namespaced name and when-to-call description", () => {
    const tool = createLocationQueryTool({ sessionKey: "agent:main:s1" });
    expect(tool.name).toBe(LOCATION_QUERY_TOOL_NAME);
    expect(tool.description).toContain("location");
    expect(tool.description).toContain("nodes.device_health");
  });

  it("returns LOCATION_DEVICE_OFFLINE when SSE is down", async () => {
    const tool = createLocationQueryTool({ sessionKey: "agent:main:s1" });
    const result = await tool.execute("call-1", {});
    const parsed = JSON.parse(result.content[0].text) as {
      error: { code: string };
    };
    expect(parsed.error.code).toBe("LOCATION_DEVICE_OFFLINE");
  });

  it("returns LOCATION_DEVICE_OFFLINE when neither the v1 emitter nor a v3 stream is live", async () => {
    getRuntimeV3Store();
    const tool = createLocationQueryTool({ sessionKey: "agent:main:s1" });
    const result = await tool.execute("call-1b", {});
    const parsed = JSON.parse(result.content[0].text) as {
      error: { code: string };
    };
    expect(parsed.error.code).toBe("LOCATION_DEVICE_OFFLINE");
  });

  it("delivers over the v3 delivery journal when only a protocol-v3 stream listener is connected", async () => {
    // 1.5 app reality: no v1 SSE connection at all — only GET /friday-next/v3/events,
    // which registers a store subscriber instead of a v1 emitter connection.
    const store = getRuntimeV3Store();
    const accepted = store.acceptCommand({
      clientRequestId: "cr-1",
      deviceId: "PHONE-1",
      sessionKey: "agent:main:s1",
      agentId: "main",
      text: "hi",
      attachments: [],
    });
    expect(accepted.outcome).toBe("accepted");
    store.transition(accepted.run!.runId, "running");

    const received: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = store.subscribe("PHONE-1", (event) => {
      received.push({
        eventType: event.eventType,
        payload: event.payload as Record<string, unknown>,
      });
    });

    const tool = createLocationQueryTool({ sessionKey: "agent:main:s1" });
    const pending = tool.execute("call-v3", {});
    await vi.waitFor(() => {
      expect(
        received.filter((e) => e.eventType === "device.location.request").length,
      ).toBeGreaterThan(0);
    });

    const request = received.find((e) => e.eventType === "device.location.request")!;
    // The v3 mirror wraps the v1 broadcast: { _sourceEventType, _sourceEventData }.
    const mirrored = (request.payload._sourceEventData ?? {}) as Record<string, unknown>;
    const requestId = String(mirrored.requestId ?? "");
    expect(requestId).toBeTruthy();
    expect(mirrored.sessionKey).toBe("agent:main:s1");
    expect(request.payload._sourceEventType).toBe("fridaynext-location-query");
    expect(
      resolveLocationQueryResult(requestId, {
        ok: true,
        payload: {
          latitude: 31.2,
          longitude: 121.5,
          horizontalAccuracy: 9,
          timestampMs: 1_700_000_000_000,
        },
      }),
    ).toBe(true);
    const result = await pending;
    const parsed = JSON.parse(result.content[0].text) as { latitude: number };
    expect(parsed.latitude).toBe(31.2);
    unsubscribe();
  });

  it("broadcasts fridaynext-location-query and returns the POST payload", async () => {
    const res = new MockRes();
    sseEmitter.addConnection("PHONE-1", res as never);
    const tool = createLocationQueryTool({ sessionKey: "agent:main:s1" });
    const pending = tool.execute("call-2", {});
    await vi.waitFor(() => {
      expect(res.writes.join("")).toContain("event: fridaynext-location-query");
    });
    const frame = res.writes.join("");
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    expect(dataLine).toBeTruthy();
    const data = JSON.parse(dataLine!.slice("data: ".length)) as { requestId: string };
    const payload = {
      latitude: 31.2,
      longitude: 121.5,
      horizontalAccuracy: 9,
      timestampMs: 1_700_000_000_000,
    };
    expect(resolveLocationQueryResult(data.requestId, { ok: true, payload })).toBe(true);
    const result = await pending;
    const parsed = JSON.parse(result.content[0].text) as { latitude: number };
    expect(parsed.latitude).toBe(31.2);
  });

  it("returns the error payload when the phone reports a gate failure", async () => {
    const res = new MockRes();
    sseEmitter.addConnection("PHONE-1", res as never);
    const tool = createLocationQueryTool({ sessionKey: "agent:main:s1" });
    const pending = tool.execute("call-3", {});
    await vi.waitFor(() => {
      expect(res.writes.join("")).toContain("event: fridaynext-location-query");
    });
    const frame = res.writes.join("");
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    const data = JSON.parse(dataLine!.slice("data: ".length)) as { requestId: string };
    expect(
      resolveLocationQueryResult(data.requestId, {
        ok: false,
        error: { code: "LOCATION_DISABLED", message: "未开启位置信息共享" },
      }),
    ).toBe(true);
    const result = await pending;
    const parsed = JSON.parse(result.content[0].text) as { ok: boolean; error: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("LOCATION_DISABLED");
  });
});
