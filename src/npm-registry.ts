/**
 * npm registry resolution for the plugin's version lookups and npm installs.
 *
 * Selection is LATENCY-AWARE: every candidate is probed in parallel and the
 * faster one wins. This matters for mainland-China gateways where
 * `registry.npmjs.org` answers slowly but reachably — reachability alone used
 * to lock them onto the slow channel (observed: a 4-minute cold install on the
 * official registry vs 31s on the China mirror). A close race still prefers
 * the official registry so the default stays stable.
 *
 * `FRIDAY_NPM_REGISTRY` env override wins without probing (authoritative).
 * When the official registry is chosen the npm env is left unset so npm keeps
 * honoring the user's own `.npmrc`.
 *
 * `alternateRegistry()` exposes the other candidate so an install that fails
 * on the preferred channel can retry once on the alternate (see
 * plugin-upgrade.ts) — one channel at a time, never two parallel installs
 * (parallel npm processes were the OOM trigger on small gateways).
 *
 * `install.js` duplicates this algorithm (it cannot import this module: the
 * npx installer is a standalone script). Keep the two in lockstep.
 */
export const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";
export const CHINA_NPM_MIRROR = "https://registry.npmmirror.com/";
export const REGISTRY_ENV_VAR = "FRIDAY_NPM_REGISTRY";

const PING_PATH = "/-/ping";
const PROBE_TIMEOUT_MS = 3_000;
/** Close race: within this delta (ms) both channels are equivalent — prefer the official. */
const RACE_EQUALITY_MS = 150;
const TTL_MS = 10 * 60_000;

const candidates: string[] = [OFFICIAL_NPM_REGISTRY, CHINA_NPM_MIRROR];

let cache: { registry: string; resolvedAt: number } | null = null;

/**
 * Probes one registry, resolving with its latency in ms. `Infinity` when the
 * registry does not answer within the probe timeout (or answers non-2xx).
 */
async function probeRegistryLatency(url: string): Promise<number> {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}${PING_PATH}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      return res.ok ? Date.now() - started : Infinity;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return Infinity;
  }
}

/**
 * Resolve the registry to use right now. Honors the `FRIDAY_NPM_REGISTRY`
 * override first (authoritative, no probe), then picks the FASTER of the
 * reachable candidates (official wins a close race), falling back to the
 * official registry when nothing responds.
 */
export async function resolveNpmRegistry(nowMs: number): Promise<string> {
  const override = process.env[REGISTRY_ENV_VAR];
  if (override && override.trim()) return override.trim();
  if (cache && nowMs - cache.resolvedAt < TTL_MS) return cache.registry;

  const results = await Promise.all(
    candidates.map(async (url) => ({ registry: url, latencyMs: await probeRegistryLatency(url) })),
  );
  const reachable = results.filter((r) => r.latencyMs !== Infinity);
  const official = results.find((r) => r.registry === OFFICIAL_NPM_REGISTRY);

  let chosen: string;
  if (reachable.length === 0) {
    chosen = OFFICIAL_NPM_REGISTRY;
  } else if (
    official &&
    official.latencyMs !== Infinity &&
    reachable.reduce((fastest, r) => (r.latencyMs < fastest.latencyMs ? r : fastest)).latencyMs +
      RACE_EQUALITY_MS >=
      official.latencyMs
  ) {
    chosen = OFFICIAL_NPM_REGISTRY;
  } else {
    chosen = reachable.reduce((fastest, r) => (r.latencyMs < fastest.latencyMs ? r : fastest)).registry;
  }
  cache = { registry: chosen, resolvedAt: nowMs };
  return chosen;
}

/**
 * The other candidate vs `preferred` — the channel to retry on when an install
 * fails on the preferred one. `undefined` when `preferred` is not a known
 * candidate (e.g. an explicit `FRIDAY_NPM_REGISTRY` override: the override is
 * authoritative and must not be silently bypassed).
 */
export function alternateRegistry(preferred: string): string | undefined {
  if (!candidates.includes(preferred)) return undefined;
  return candidates.find((c) => c !== preferred);
}

/**
 * Env block to pass to an npm subprocess so it installs from the resolved
 * registry. `undefined` when the official registry is in use — npm then keeps
 * using its own configured registry (`.npmrc` untouched). Pass `forcedRegistry`
 * to bypass resolution (install failover to the alternate channel).
 */
export async function npmRegistryEnv(
  nowMs: number,
  forcedRegistry?: string,
): Promise<NodeJS.ProcessEnv | undefined> {
  const registry = forcedRegistry ?? (await resolveNpmRegistry(nowMs));
  if (registry === OFFICIAL_NPM_REGISTRY) return undefined;
  return { npm_config_registry: registry };
}

/** Vitest-only */
export function resetNpmRegistryCacheForTest(): void {
  cache = null;
}
