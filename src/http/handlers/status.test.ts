import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleStatus } from "./status.js";
import { clearFridayNextRuntime, setFridayNextRuntime } from "../../runtime.js";

class MockRes extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  end(body?: string): void {
    if (body) this.body += body;
    this.emit("finish");
  }
}

describe("handleStatus", () => {
  afterEach(() => {
    clearFridayNextRuntime();
  });

  it("401 without bearer", async () => {
    setFridayNextRuntime({
      config: { loadConfig: () => ({ gateway: { auth: { token: "tok" } }, channels: {} }) },
    } as never);
    const req = { method: "GET", headers: {} } as IncomingMessage;
    const res = new MockRes() as unknown as ServerResponse;
    await handleStatus(req, res);
    expect((res as unknown as MockRes).statusCode).toBe(401);
  });

  it("returns channel health payload", async () => {
    setFridayNextRuntime({
      config: { loadConfig: () => ({ gateway: { auth: { token: "tok" } }, channels: {} }) },
    } as never);
    const req = {
      method: "GET",
      headers: { authorization: "Bearer tok" },
    } as IncomingMessage;
    const res = new MockRes() as unknown as ServerResponse;
    const handled = await handleStatus(req, res);
    expect(handled).toBe(true);
    expect((res as unknown as MockRes).statusCode).toBe(200);
    const body = JSON.parse((res as unknown as MockRes).body) as Record<string, unknown>;
    expect(body.channel).toBe("friday-next");
    expect(Array.isArray(body.activeRuns)).toBe(true);
    expect(typeof body.activeRunCount).toBe("number");
  });
});
