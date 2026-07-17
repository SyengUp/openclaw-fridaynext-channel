import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleSseStream } from "./sse.js";
import { setFridayNextRuntime } from "../../runtime.js";
import { sseEmitter } from "../../sse/emitter.js";

class MockReq extends EventEmitter {
  method = "GET";
  url = "/friday-next/events?deviceId=dev-a&lastEventId=3";
  headers: Record<string, string> = {
    authorization: "Bearer t1",
  };
}

class MockRes extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  writes: string[] = [];
  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  flushHeaders(): void {
    // no-op
  }
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
  end(body?: string): void {
    if (body) this.writes.push(body);
  }
}

describe("handleSseStream", () => {
  it("returns 401 when bearer missing", async () => {
    setFridayNextRuntime({
      config: { loadConfig: () => ({ channels: { "friday-next": { authToken: "t1" } } }) },
    } as never);
    const req = new MockReq() as unknown as IncomingMessage;
    (req as IncomingMessage).headers = {};
    const res = new MockRes() as unknown as ServerResponse;
    await handleSseStream(req, res);
    expect((res as unknown as MockRes).statusCode).toBe(401);
  });

  it("sets SSE headers and replays from Last-Event-ID", async () => {
    setFridayNextRuntime({
      config: {
        loadConfig: () => ({
          channels: {
            "friday-next": {
              authToken: "t1",
              sse: { keepaliveSec: 30, backlogPerDevice: 20 },
            },
          },
        }),
      },
    } as never);
    const req = new MockReq() as unknown as IncomingMessage;
    const res = new MockRes() as unknown as ServerResponse;
    const spyReplay = vi.spyOn(sseEmitter, "replayBacklog").mockReturnValue(0);
    await handleSseStream(req, res);
    const headers = (res as unknown as MockRes).headers;
    expect((res as unknown as MockRes).statusCode).toBe(200);
    expect(headers["content-type"]).toContain("text/event-stream");
    expect(spyReplay).toHaveBeenCalledWith("dev-a", 3);
    (req as unknown as MockReq).emit("close");
    spyReplay.mockRestore();
  });

  it("marks the connection viaPublic when the filter-proxy marker is present (and not otherwise)", async () => {
    setFridayNextRuntime({
      config: { loadConfig: () => ({ channels: { "friday-next": { authToken: "t1" } } }) },
    } as never);

    // LAN-direct: no marker → viaPublic false.
    const lanReq = new MockReq() as unknown as IncomingMessage;
    const lanRes = new MockRes() as unknown as ServerResponse;
    await handleSseStream(lanReq, lanRes);
    expect(sseEmitter.getConnection("dev-a")?.viaPublic).toBe(false);
    expect(sseEmitter.isDeviceOnPublicSurface("dev-a")).toBe(false);
    (lanReq as unknown as MockReq).emit("close");

    // Via the public relay: filter proxy stamped the marker → viaPublic true.
    const pubReq = new MockReq() as unknown as IncomingMessage;
    (pubReq as unknown as MockReq).headers["x-fridaynext-public"] = "1";
    const pubRes = new MockRes() as unknown as ServerResponse;
    await handleSseStream(pubReq, pubRes);
    expect(sseEmitter.getConnection("dev-a")?.viaPublic).toBe(true);
    expect(sseEmitter.isDeviceOnPublicSurface("dev-a")).toBe(true);
    (pubReq as unknown as MockReq).emit("close");
  });
});
