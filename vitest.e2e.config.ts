import { defineConfig } from "vitest/config";
import path from "node:path";
import { existsSync } from "node:fs";

function resolveOpenClawDist(): string {
  const candidates = [
    process.env.OPENCLAW_DIST,
    path.join(process.env.APPDATA ?? "", "npm/node_modules/openclaw/dist"),     // Windows npm -g
    "/opt/homebrew/lib/node_modules/openclaw/dist",                              // macOS Homebrew
    "/home/linuxbrew/.linuxbrew/lib/node_modules/openclaw/dist",                 // Linux Homebrew
    "/usr/local/lib/node_modules/openclaw/dist",                                 // Unix npm -g
  ].filter(Boolean) as string[];
  const found = candidates.find((p) => existsSync(p));
  if (found) return found;
  throw new Error("OpenClaw dist not found. Set OPENCLAW_DIST env var.");
}

const openclawDist = resolveOpenClawDist();

export default defineConfig({
  resolve: {
    alias: {
      openclaw: openclawDist,
    },
  },
  test: {
    environment: "node",
    include: ["src/e2e/**/*.e2e.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
