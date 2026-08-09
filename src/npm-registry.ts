/**
 * npm registry resolution for the plugin's version lookups and npm installs.
 *
 * Every npm touchpoint used to hard-code `registry.npmjs.org`. Mainland China
 * ISPs frequently degrade or block that Cloudflare-backed host, so on such a
 * gateway an install/upgrade waits out npm's 5-minute fetch timeout on every
 * request — "the install is stuck". This module picks a REACHABLE registry:
 * `FRIDAY_NPM_REGISTRY` env override → official → China mirror (npmmirror),
 * first one that answers `/-/ping` wins, result cached ~10 min.
 *
 * Callers use the resolved URL for HTTP version lookups, and inject
 * `npm_config_registry` (via `npmRegistryEnv`) into the `openclaw plugins
 * install` subprocess env so npm itself uses the reachable registry instead of
 * its default. When the official registry is reachable the env is left unset so
 * npm keeps honoring the user's own `.npmrc`.
 */
export const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";
export const CHINA_NPM_MIRROR = "https://registry.npmmirror.com/";
export const REGISTRY_ENV_VAR = "FRIDAY_NPM_REGISTRY";

const PING_PATH = "/-/ping";
const PROBE_TIMEOUT_MS = 3_000;
const TTL_MS = 10 * 60_000;

const candidates: string[] = [OFFICIAL_NPM_REGISTRY, CHINA_NPM_MIRROR];

let cache: { registry: string; resolvedAt: number } | null = null;

/** True when the registry answers `/-/ping` within the probe timeout. */
async function probeRegistry(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}${PING_PATH}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * Resolve the registry to use right now. Honors the `FRIDAY_NPM_REGISTRY`
 * override first (authoritative, no probe), then returns the first reachable
 * candidate, falling back to the official registry when nothing responds.
 */
export async function resolveNpmRegistry(nowMs: number): Promise<string> {
  const override = process.env[REGISTRY_ENV_VAR];
  if (override && override.trim()) return override.trim();
  if (cache && nowMs - cache.resolvedAt < TTL_MS) return cache.registry;
  for (const url of candidates) {
    if (await probeRegistry(url)) {
      cache = { registry: url, resolvedAt: nowMs };
      return url;
    }
  }
  return OFFICIAL_NPM_REGISTRY;
}

/**
 * Env block to pass to an npm subprocess so it installs from the resolved
 * registry. `undefined` when the official registry is reachable — npm then
 * keeps using its own configured registry (`.npmrc` untouched).
 */
export async function npmRegistryEnv(nowMs: number): Promise<NodeJS.ProcessEnv | undefined> {
  const registry = await resolveNpmRegistry(nowMs);
  if (registry === OFFICIAL_NPM_REGISTRY) return undefined;
  return { npm_config_registry: registry };
}

/** Vitest-only */
export function resetNpmRegistryCacheForTest(): void {
  cache = null;
}
