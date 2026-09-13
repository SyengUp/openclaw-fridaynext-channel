import { beforeEach, describe, expect, it } from "vitest";
import {
  clearStructuredRunSource,
  noteStructuredRunSource,
  resetStructuredRunSourcesForTest,
  structuredRunSource,
} from "./run-source.js";

describe("structured run source", () => {
  beforeEach(() => resetStructuredRunSourcesForTest());

  it("只接受明确的 host trigger", () => {
    expect(noteStructuredRunSource("run-user", "user")).toBe("session");
    expect(noteStructuredRunSource("run-cron", "cron")).toBe("cron");
    expect(noteStructuredRunSource("run-heartbeat", "heartbeat")).toBe("heartbeat");
    expect(noteStructuredRunSource("run-subagent", "subagent")).toBe("subagent");
    expect(noteStructuredRunSource("run-unknown", "manual")).toBeUndefined();
    expect(structuredRunSource("run-unknown")).toBeUndefined();
  });

  it("按精确 runId 绑定并在终态后清除", () => {
    noteStructuredRunSource("run-1", "user");
    expect(structuredRunSource("run-1")).toBe("session");
    expect(structuredRunSource("run-2")).toBeUndefined();
    clearStructuredRunSource("run-1");
    expect(structuredRunSource("run-1")).toBeUndefined();
  });
});
