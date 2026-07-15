/**
 * Helpers for the plugin upgrade feature: read this plugin's install record
 * (source: "npm" vs "path"/dev), compare semver, and look up the latest version
 * published to the npm registry (cached).
 */
import { getUpgradeRuntime } from "./upgrade-runtime.js";
import { PLUGIN_ID, PLUGIN_PACKAGE_NAME } from "./version.js";

/** Install source from the OpenClaw config `plugins.installs[<id>].source`. */
export type InstallSource =
  | "npm"
  | "path"
  | "archive"
  | "clawhub"
  | "git"
  | "marketplace"
  | "unknown";

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
export function classifyInstallSourceFromLoadedPath(
  loadedPath: string | null | undefined,
): InstallSource {
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
    const cfg = rt.currentConfig() as
      | {
          plugins?: { installs?: Record<string, { source?: string } | undefined> };
        }
      | undefined;
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

/** True when a version carries a prerelease suffix, e.g. "1.0.15-beta.0". */
export function isPrereleaseVersion(v: string | null | undefined): boolean {
  if (!v) return false;
  return v.trim().replace(/^v/i, "").includes("-");
}

/**
 * Strict-greater semver compare INCLUDING prerelease ordering:
 *   1.0.15-beta.0 < 1.0.15-beta.1 < 1.0.15 < 1.0.16
 * Unlike `semverGreater` (which ignores the suffix so stable-line comparisons
 * don't churn on prerelease noise), this powers the beta channel so beta.0 →
 * beta.1 lights up the upgrade button. A stable version outranks any prerelease
 * of the same core version (semver §11).
 */
export function semverGreaterConsideringPrerelease(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  const ra = prereleaseIdentifiers(a);
  const rb = prereleaseIdentifiers(b);
  if (ra.length === 0 && rb.length === 0) return false;
  if (ra.length === 0) return true; // a stable, b prerelease → a > b
  if (rb.length === 0) return false; // a prerelease, b stable → a < b
  const n = Math.max(ra.length, rb.length);
  for (let i = 0; i < n; i++) {
    if (i >= ra.length) return false; // a's identifiers ran out first → a < b
    if (i >= rb.length) return true; // b's identifiers ran out first → a > b
    const cmp = comparePrereleaseIdentifier(ra[i], rb[i]);
    if (cmp !== 0) return cmp > 0;
  }
  return false;
}

/** The dot-separated prerelease identifiers of a version, or [] if none. */
function prereleaseIdentifiers(v: string): string[] {
  const core = v.trim().replace(/^v/i, "").split("+")[0]; // drop build metadata
  const dash = core.indexOf("-");
  if (dash < 0) return [];
  return core.slice(dash + 1).split(".");
}

/**
 * Compare two prerelease identifiers per semver §11: numeric identifiers have
 * lower precedence than alphanumeric, numerics compare numerically, others by
 * ASCII. Returns -1 / 0 / 1.
 */
function comparePrereleaseIdentifier(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) {
    const da = Number.parseInt(a, 10);
    const db = Number.parseInt(b, 10);
    return da === db ? 0 : da > db ? 1 : -1;
  }
  if (na) return -1;
  if (nb) return 1;
  return a === b ? 0 : a > b ? 1 : -1;
}

const versionCacheByTag = new Map<string, { version: string | null; fetchedAt: number }>();
const LATEST_TTL_MS = 10 * 60 * 1000;

/**
 * Fetch the newest published version on a dist-tag (`latest` default, or `beta`
 * for the public-access preview line), cached ~10min per tag. Null on failure.
 */
export async function fetchLatestVersion(
  nowMs: number,
  distTag: "latest" | "beta" = "latest",
): Promise<string | null> {
  const cached = versionCacheByTag.get(distTag);
  if (cached && nowMs - cached.fetchedAt < LATEST_TTL_MS) {
    return cached.version;
  }
  let version: string | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`https://registry.npmjs.org/${PLUGIN_PACKAGE_NAME}/${distTag}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
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
  versionCacheByTag.set(distTag, { version, fetchedAt: nowMs });
  return version;
}

/** Vitest-only */
export function resetLatestVersionCacheForTest(): void {
  versionCacheByTag.clear();
}
