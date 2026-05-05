import { describe, expect, it } from "vitest";
import { applyCorsHeaders } from "./cors.js";
import { setFridayNextRuntime } from "../../runtime.js";

class MockRes {
  headers: Record<string, string> = {};
  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
}

describe("applyCorsHeaders", () => {
  it("does nothing when cors disabled", () => {
    setFridayNextRuntime({
      config: { loadConfig: () => ({ channels: { "friday-next": { cors: { enabled: false } } } }) },
    } as never);
    const res = new MockRes();
    applyCorsHeaders(res as never);
    expect(Object.keys(res.headers)).toHaveLength(0);
  });

  it("sets configured cors headers", () => {
    setFridayNextRuntime({
      config: {
        loadConfig: () => ({
          channels: {
            "friday-next": {
              cors: { enabled: true, allowOrigin: "https://app.local" },
            },
          },
        }),
      },
    } as never);
    const res = new MockRes();
    applyCorsHeaders(res as never);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("https://app.local");
    expect(res.headers["Access-Control-Allow-Headers"]).toContain("Authorization");
    expect(res.headers["Access-Control-Allow-Methods"]).toContain("OPTIONS");
  });
});
