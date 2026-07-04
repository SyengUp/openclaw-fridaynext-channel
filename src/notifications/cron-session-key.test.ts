import { describe, expect, it } from "vitest";
import { cronJobIdFromSessionKey } from "./cron-session-key.js";

describe("cronJobIdFromSessionKey", () => {
  it("extracts jobId from a per-run cron session key", () => {
    expect(
      cronJobIdFromSessionKey(
        "agent:main:cron:118487ff-d08e-4e3f-8d68-c6e2ba40c643:run:99585514-fb5a-48f4-a709-a20d1ee52167",
      ),
    ).toBe("118487ff-d08e-4e3f-8d68-c6e2ba40c643");
  });

  it("extracts jobId from a stable cron session key (no run suffix)", () => {
    expect(cronJobIdFromSessionKey("agent:main:cron:job-42")).toBe("job-42");
  });

  it("is case-insensitive on the :cron: marker", () => {
    expect(cronJobIdFromSessionKey("agent:Main:CRON:abc123:run:x")).toBe("abc123");
  });

  it("returns null for non-cron keys (normal reply / heartbeat / empty)", () => {
    expect(cronJobIdFromSessionKey("agent:main:fridaynext:mr512g1e")).toBeNull();
    expect(cronJobIdFromSessionKey("agent:main:heartbeat")).toBeNull();
    expect(cronJobIdFromSessionKey("")).toBeNull();
    expect(cronJobIdFromSessionKey(undefined)).toBeNull();
  });
});
