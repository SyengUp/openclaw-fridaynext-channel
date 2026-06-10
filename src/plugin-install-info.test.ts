import { describe, expect, it } from "vitest";
import { classifyInstallSourceFromLoadedPath, semverGreater } from "./plugin-install-info.js";

describe("classifyInstallSourceFromLoadedPath", () => {
  it("treats paths under the managed npm projects dir as npm", () => {
    expect(
      classifyInstallSourceFromLoadedPath(
        "/Users/me/.openclaw/npm/projects/syengup-friday-channel-next-ef89e139a1/node_modules/@syengup/friday-channel-next/dist/index.js",
      ),
    ).toBe("npm");
    // install-path form (no /dist/index.js suffix) also resolves to npm
    expect(
      classifyInstallSourceFromLoadedPath(
        "/Users/me/.openclaw/npm/projects/syengup-friday-channel-next-ef89e139a1/node_modules/@syengup/friday-channel-next",
      ),
    ).toBe("npm");
  });

  it("treats a dev/link checkout path as path", () => {
    expect(
      classifyInstallSourceFromLoadedPath(
        "/Users/me/Documents/Project/Friday-Next/openclaw-fridaynext-channel/dist/index.js",
      ),
    ).toBe("path");
  });

  it("returns unknown for missing/empty input", () => {
    expect(classifyInstallSourceFromLoadedPath(null)).toBe("unknown");
    expect(classifyInstallSourceFromLoadedPath(undefined)).toBe("unknown");
    expect(classifyInstallSourceFromLoadedPath("")).toBe("unknown");
  });
});

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
