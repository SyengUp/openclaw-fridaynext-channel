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
 * Read the install source for this plugin from the live config snapshot.
 * Returns "unknown" when the record can't be resolved (e.g. runtime not captured).
 * Only "npm" is auto-upgradable; "path" means a dev (load.paths) install which must
 * never be npm-upgraded (would duplicate-install and break agent media sends).
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
    return "unknown";
  } catch {
    return "unknown";
  }
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
