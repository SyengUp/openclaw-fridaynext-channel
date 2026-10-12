/**
 * SDK 子路径护栏：静态 import 已移除的兼容子路径会让整个插件在宿主上
 * ERR_PACKAGE_PATH_NOT_EXPORTED 加载失败（2026.10.1 实测）。
 *
 * OpenClaw 2026-09-30/2026-10-02 两批提前退休的子路径（见宿主
 * docs/plugins/sdk-migration/removal-timeline.md）不允许再被静态 import。
 * 需要兼容新旧宿主时，用带 try/catch 的动态 import（如
 * channel-lifecycle-compat.ts 的模式），不要退回静态导入。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const SELF = join(import.meta.dirname, "sdk-subpath-guard.test.ts");

/** 宿主已移除、禁止静态 import 的兼容子路径。 */
const REMOVED_SDK_SUBPATHS = [
  "channel-lifecycle",
  "channel-message",
  "channel-reply-pipeline",
  "config-runtime",
  "infra-runtime",
  "command-auth",
  "discord",
  "telegram-account",
];

function collectTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...collectTypeScriptFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("OpenClaw SDK 子路径护栏", () => {
  it("index.ts 与 src/ 不再静态 import 宿主已移除的兼容子路径", () => {
    const files = [join(root, "index.ts"), ...collectTypeScriptFiles(join(root, "src"))].filter(
      (file) => file !== SELF,
    );
    expect(files.length).toBeGreaterThan(50);

    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const subpath of REMOVED_SDK_SUBPATHS) {
        const pattern = new RegExp(
          `(?:from\\s+|import\\s+)["']openclaw/plugin-sdk/${subpath}["']`,
        );
        if (pattern.test(text)) {
          violations.push(`${relative(root, file)} -> openclaw/plugin-sdk/${subpath}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
