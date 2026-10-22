import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  files: string[];
  scripts: Record<string, string>;
  openclaw: { extensions: string[] };
  dependencies: Record<string, string>;
  bundledDependencies?: string[];
};

describe("npm artifact boundary", () => {
  it("npm 发布包使用固定 registry 依赖，由 npm 安装 Kit", () => {
    expect(pkg.dependencies["@syengup/fridaynext-channel-kit"]).toBe("0.1.3");
    expect(pkg.bundledDependencies ?? []).not.toContain("@syengup/fridaynext-channel-kit");
    expect(pkg.files.some((entry) => entry.startsWith("vendor/"))).toBe(false);
  });
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
