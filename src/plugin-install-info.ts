/**
 * Helpers for the plugin upgrade feature: read this plugin's install record
 * (source: "npm" vs "path"/dev), compare semver, and look up the latest version
 * published to the npm registry (cached).
 */
import { getUpgradeRuntime } from "./upgrade-runtime.js";
import { PLUGIN_ID, PLUGIN_PACKAGE_NAME } from "./version.js";

/** Install source from the OpenClaw config `plugins.installs[<id>].source`. */
export type InstallSource = "npm" | "path" | "archive" | "clawhub" | "git" | "marketplace" | "unknown";

/**
 * Infer the install source from the loaded plugin's filesystem path (`api.source`).
 *
 * OpenClaw copies non-dev installs (npm/archive/clawhub/git) into
 * `~/.openclaw/npm/projects/<hash>/node_modules/...`, whereas a dev install
 * (`load.paths` / `plugins install --link`) is loaded directly from the source
 * checkout. For this plugin's purposes the only distinction that matters is
 * npm-managed (auto-upgradable) vs dev (must never npm-upgrade — see
 * dev-no-duplicate-plugin-install), so anything under the managed projects dir
 * is treated as "npm".
 */
export function classifyInstallSourceFromLoadedPath(loadedPath: string | null | undefined): InstallSource {
  if (!loadedPath) return "unknown";
  return loadedPath.includes("/.openclaw/npm/projects/") ? "npm" : "path";
}

/**
 * Resolve the install source for this plugin (npm vs dev path).
 * Returns "unknown" when it can't be resolved (e.g. runtime not captured).
 * Only "npm" is auto-upgradable; "path" means a dev (load.paths / --link) install
 * which must never be npm-upgraded (would duplicate-install and break agent media sends).
 *
 * Resolution order:
 *  1. The explicit `plugins.installs[<id>].source` config record — present on older
 *     OpenClaw builds that surface install records in the runtime config snapshot.
 *  2. Fallback: OpenClaw 2026.6.x moved install records out of the config snapshot
 *     into a separate registry (~/.openclaw/state.db), leaving `plugins.installs`
 *     unset — so infer from the loaded plugin path (`api.source`) instead.
 */
export function getInstallSource(): InstallSource {
  const rt = getUpgradeRuntime();
  if (!rt) return "unknown";
  try {
    const cfg = rt.currentConfig() as {
      plugins?: { installs?: Record<string, { source?: string } | undefined> };
    } | undefined;
    const source = cfg?.plugins?.installs?.[PLUGIN_ID]?.source;
    if (
      source === "npm" ||
      source === "path" ||
      source === "archive" ||
      source === "clawhub" ||
      source === "git" ||
      source === "marketplace"
    ) {
      return source;
    }
  } catch {
    // fall through to the path-based heuristic
  }
  return classifyInstallSourceFromLoadedPath(rt.pluginSource);
}

/** Compare dotted numeric versions. Returns true if `a` is strictly greater than `b`. */
export function semverGreater(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

function parseSemver(v: string): [number, number, number] {
  // Strip a leading "v" and any pre-release/build suffix, keep major.minor.patch.
  const core = v.trim().replace(/^v/i, "").split(/[-+]/)[0];
  const parts = core.split(".").map((p) => Number.parseInt(p, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

let cachedLatest: { version: string | null; fetchedAt: number } | null = null;
const LATEST_TTL_MS = 10 * 60 * 1000;

/** Fetch the latest published version from the npm registry (cached ~10min). Null on failure. */
export async function fetchLatestVersion(nowMs: number): Promise<string | null> {
  if (cachedLatest && nowMs - cachedLatest.fetchedAt < LATEST_TTL_MS) {
    return cachedLatest.version;
  }
  let version: string | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(
        `https://registry.npmjs.org/${PLUGIN_PACKAGE_NAME}/latest`,
        { signal: controller.signal, headers: { Accept: "application/json" } },
      );
      if (res.ok) {
        const body = (await res.json()) as { version?: string };
        if (typeof body.version === "string" && body.version) version = body.version;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    version = null;
  }
  cachedLatest = { version, fetchedAt: nowMs };
  return version;
}

/** Vitest-only */
export function resetLatestVersionCacheForTest(): void {
  cachedLatest = null;
}
