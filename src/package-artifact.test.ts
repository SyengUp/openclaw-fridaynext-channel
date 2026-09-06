import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  files: string[];
  scripts: Record<string, string>;
  openclaw: { extensions: string[] };
};

describe("npm artifact boundary", () => {
  it("ships compiled runtime, not source, tests, marketing screenshots, or build config", () => {
    expect(pkg.files).toContain("dist/");
    expect(pkg.files).toContain("install-runtime.js");
    expect(pkg.files).not.toEqual(
      expect.arrayContaining(["index.ts", "src/**", "assets/", "tsconfig.json"]),
    );
    expect(pkg.openclaw.extensions).toEqual(["./dist/index.js"]);
  });

  it("cleans dist before every build and validates the publish artifact", () => {
    expect(pkg.scripts.clean).toBe("node scripts/clean-dist.mjs");
    expect(pkg.scripts.build).toContain("pnpm clean");
    expect(pkg.scripts.prepack).toContain("package:check");
  });
});
