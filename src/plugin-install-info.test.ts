import { describe, expect, it } from "vitest";
import { semverGreater } from "./plugin-install-info.js";

describe("semverGreater", () => {
  it("returns true when a is a higher patch/minor/major", () => {
    expect(semverGreater("0.1.27", "0.1.26")).toBe(true);
    expect(semverGreater("0.2.0", "0.1.99")).toBe(true);
    expect(semverGreater("1.0.0", "0.9.9")).toBe(true);
  });

  it("returns false when equal or lower", () => {
    expect(semverGreater("0.1.27", "0.1.27")).toBe(false);
    expect(semverGreater("0.1.26", "0.1.27")).toBe(false);
    expect(semverGreater("0.1.0", "0.1.0")).toBe(false);
  });

  it("tolerates a leading v and pre-release/build suffixes", () => {
    expect(semverGreater("v0.1.27", "0.1.26")).toBe(true);
    expect(semverGreater("0.1.27-beta.1", "0.1.26")).toBe(true);
    expect(semverGreater("0.1.27", "0.1.27-rc.1")).toBe(false);
  });

  it("returns false for null/undefined inputs", () => {
    expect(semverGreater(null, "0.1.0")).toBe(false);
    expect(semverGreater("0.1.0", null)).toBe(false);
    expect(semverGreater(undefined, undefined)).toBe(false);
  });
});
