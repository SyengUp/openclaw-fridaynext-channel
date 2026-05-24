import { defineConfig } from "vitest/config";
import path from "node:path";
import { existsSync, realpathSync, readdirSync } from "node:fs";

function resolveOpenClawDistFromPath(): string | null {
  const binName = process.platform === "win32" ? "openclaw.cmd" : "openclaw";
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, binName);
    if (!existsSync(candidate)) continue;
    try {
      const real = realpathSync(candidate);
      const dist = path.join(path.dirname(real), "dist");
      readdirSync(dist);
      return dist;
    } catch {}
  }
  return null;
}

function resolveOpenClawDist(): string {
  const candidates = [
    process.env.OPENCLAW_DIST,
    resolveOpenClawDistFromPath(),
    path.join(process.env.APPDATA ?? "", "npm/node_modules/openclaw/dist"),     // Windows npm -g
    path.join(process.env.LOCALAPPDATA ?? "", "npm/node_modules/openclaw/dist"), // Windows npm -g (alt)
    "/opt/homebrew/lib/node_modules/openclaw/dist",                              // macOS Homebrew
    "/home/linuxbrew/.linuxbrew/lib/node_modules/openclaw/dist",                 // Linux Homebrew
    "/usr/local/lib/node_modules/openclaw/dist",                                 // Unix npm -g
    "/usr/lib/node_modules/openclaw/dist",                                       // Linux npm -g (prefix=/usr)
  ].filter(Boolean) as string[];
  const found = candidates.find((p) => existsSync(p));
  if (found) return found;
  throw new Error("OpenClaw dist not found. Set OPENCLAW_DIST env var.");
}

const openclawDist = resolveOpenClawDist();

export default defineConfig({
  resolve: {
    alias: {
      "openclaw/plugin-sdk/device-bootstrap": path.resolve(__dirname, "src/test-support/mock-device-bootstrap.ts"),
      openclaw: openclawDist,
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.e2e.test.ts"],
  },
});
