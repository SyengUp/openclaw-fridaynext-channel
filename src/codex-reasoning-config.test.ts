import { describe, expect, it } from "vitest";
import { hasTopLevelSummaryKey } from "./codex-reasoning-config.js";

describe("hasTopLevelSummaryKey", () => {
  it("returns true when the key is a top-level entry", () => {
    expect(hasTopLevelSummaryKey('model_reasoning_summary = "detailed"\n')).toBe(true);
    expect(
      hasTopLevelSummaryKey('model_reasoning_summary = "auto"\n\n[projects."/x"]\ntrust_level = "trusted"\n'),
    ).toBe(true);
  });

  it("returns false when the file has no key", () => {
    expect(hasTopLevelSummaryKey("")).toBe(false);
    expect(hasTopLevelSummaryKey('[projects."/x"]\ntrust_level = "trusted"\n')).toBe(false);
  });

  it("treats a key nested under a [section] as NOT top-level (TOML scoping)", () => {
    // This is the trap: appended after a table header the key belongs to that table, so Codex
    // ignores it. Must be reported as absent so the caller prepends a real top-level key.
    const nested = '[projects."/x"]\ntrust_level = "trusted"\nmodel_reasoning_summary = "detailed"\n';
    expect(hasTopLevelSummaryKey(nested)).toBe(false);
  });

  it("ignores commented or partial matches", () => {
    expect(hasTopLevelSummaryKey('# model_reasoning_summary = "detailed"\n')).toBe(false);
    expect(hasTopLevelSummaryKey("model_reasoning_summary_extra = 1\n")).toBe(false);
  });
});
