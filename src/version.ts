/**
 * Plugin self-version.
 *
 * Resolved at module load by reading this package's own package.json relative to
 * the compiled module URL. `tsc` does NOT copy package.json into `dist/`, and a
 * JSON `import` would rewrite to a non-existent `dist/package.json`, so we read
 * the real file from disk and walk a couple of candidate paths. Falls back to a
 * hardcoded constant if the file can't be located (keep in sync with package.json).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Keep in sync with package.json "version" as a last-resort fallback. */
const FALLBACK_VERSION = "0.1.30";

function resolvePluginVersion(): string {
  // dist layout: <root>/dist/src/version.js → ../../package.json = <root>/package.json
  // source layout (vitest/jiti): <root>/src/version.ts → ../package.json = <root>/package.json
  const candidates = ["../../package.json", "../package.json"];
  for (const rel of candidates) {
    try {
      const path = fileURLToPath(new URL(rel, import.meta.url));
      const raw = readFileSync(path, "utf8");
      const pkg = JSON.parse(raw) as { name?: string; version?: string };
      if (pkg.name === "@syengup/friday-channel-next" && typeof pkg.version === "string" && pkg.version) {
        return pkg.version;
      }
    } catch {
      // try next candidate
    }
  }
  return FALLBACK_VERSION;
}

export const PLUGIN_VERSION: string = resolvePluginVersion();

/** npm package name, used for the upgrade spec and registry lookup. */
export const PLUGIN_PACKAGE_NAME = "@syengup/friday-channel-next";

/** Plugin id as registered with OpenClaw (used to read the install record). */
export const PLUGIN_ID = "friday-next";
