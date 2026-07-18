import { describe, expect, it } from "vitest";
import { allowed, normalizedPath } from "./filter-proxy.js";

// The filter proxy IS the public-surface security boundary: everything reachable through the
// tunnel goes through `allowed()`. These tests pin the allowlist/denylist semantics and the
// traversal normalization so a regression can't silently expose core's /chat or ControlUI.
describe("filter-proxy normalizedPath", () => {
  it("strips query and resolves dot segments", () => {
    expect(normalizedPath("/friday-next/health?x=1")).toBe("/friday-next/health");
    expect(normalizedPath("/friday-next/../__openclaw__/control")).toBe("/__openclaw__/control");
    expect(normalizedPath("/friday-next/./events")).toBe("/friday-next/events");
  });

  it("decodes %2e traversal", () => {
    expect(normalizedPath("/friday-next/%2e%2e/__openclaw__/control")).toBe(
      "/__openclaw__/control",
    );
  });

  it("collapses duplicate slashes", () => {
    expect(normalizedPath("/friday-next//events")).toBe("/friday-next/events");
  });

  it("treats a leading // as an authority, not a path — which lands on deny", () => {
    // `new URL("//x/y", base)` parses `x` as a HOST; the resulting pathname never
    // matches the allowlist, so authority-smuggling attempts are denied, not forwarded.
    expect(allowed("//friday-next//events")).toBe(false);
  });

  it("degrades malformed input to /", () => {
    expect(normalizedPath("http://")).toBe("/");
  });
});

describe("filter-proxy allowed", () => {
  it.each([
    "/friday-next/health",
    "/friday-next/events",
    "/friday-next/pair/claim",
    "/friday-next-admin/sessions?sessionKey=x",
    "/gateway",
    "/__openclaw__/a2ui/page",
  ])("allows app surface: %s", (p) => {
    expect(allowed(p)).toBe(true);
  });

  it.each([
    "/",
    "/chat",
    "/control",
    "/friday-nextx/evil", // prefix must be segment-bounded
    "/__openclaw__/control",
    "/__openclaw__/control/panel",
    "/__openclaw__/config/dump",
    "/__openclaw__/api/anything",
    "/__openclaw__", // bare index
    "/__openclaw__/",
  ])("denies everything else: %s", (p) => {
    expect(allowed(p)).toBe(false);
  });

  it("denies traversal-smuggled control paths", () => {
    expect(allowed("/friday-next/../__openclaw__/control")).toBe(false);
    expect(allowed("/friday-next/%2e%2e/__openclaw__/control")).toBe(false);
    expect(allowed("/__openclaw__//control")).toBe(false);
  });
});
