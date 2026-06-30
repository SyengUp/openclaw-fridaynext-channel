import { afterEach, describe, expect, it } from "vitest";
import {
  clearRecentAborts,
  markUserAbort,
  RECENT_ABORT_SUPPRESSION_MS,
  wasRecentlyUserAborted,
} from "./recent-aborts.js";

afterEach(() => clearRecentAborts());

describe("recent-aborts", () => {
  it("reports a sessionKey as recently aborted within the window", () => {
    markUserAbort("sk-1", 1_000);
    expect(wasRecentlyUserAborted("sk-1", 1_000)).toBe(true);
    expect(wasRecentlyUserAborted("sk-1", 1_000 + RECENT_ABORT_SUPPRESSION_MS)).toBe(true);
  });

  it("expires after the window", () => {
    markUserAbort("sk-2", 1_000);
    expect(wasRecentlyUserAborted("sk-2", 1_000 + RECENT_ABORT_SUPPRESSION_MS + 1)).toBe(false);
  });

  it("is false for an unknown or empty sessionKey", () => {
    expect(wasRecentlyUserAborted("never", 1_000)).toBe(false);
    expect(wasRecentlyUserAborted("   ", 1_000)).toBe(false);
    markUserAbort("   ", 1_000);
    expect(wasRecentlyUserAborted("   ", 1_000)).toBe(false);
  });
});
