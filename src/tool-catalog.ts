/**
 * Build an agent's tool-permission catalog for the app's toolbox editor — the same
 * tools/categories/descriptions/profiles ControlUI shows.
 *
 * Two builders, because the host surface decides which one is reachable:
 *
 * - `buildAgentToolsCatalog` (current): dispatches the gateway `tools.catalog` method
 *   through the supported plugin SDK (`openclaw/plugin-sdk/gateway-method-runtime`).
 *   The gateway method runs core's real builder and returns the same result, without
 *   importing a hash-named core dist chunk. Use it from a gateway-authed route (the
 *   admin sibling prefix), which carries an operator scope.
 *
 * - `buildAgentToolsCatalogLegacy`: the old deep-import path. OpenClaw's external-plugin
 *   generation capture only mirrors the host's static dependency closure, so importing a
 *   captured core chunk that transitively needs `jiti` (via `jiti-factory`) fails with
 *   `ERR_MODULE_NOT_FOUND: jiti` on 2026.9.5+. It still works on ≤2026.9.4 and is kept for
 *   the plugin-authed `/friday-next/agents/{id}/tools/catalog` route that un-upgraded apps
 *   call (that route has an empty operator scope list, so it can't dispatch scoped methods).
 *
 * Both share `projectAgentTools`, which resolves per-tool `enabled`/`inProfile` from the
 * agent's `tools` config so the app can render simple toggles.
 */

import fs from "node:fs";
import path from "node:path";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { importAbsoluteModule } from "./import-absolute-module.js";
import { resolveOpenClawRoot } from "./skills-discovery.js";
import { findAgentRosterConfig } from "./agent-roster.js";

interface CoreCatalogTool {
  id: string;
  label: string;
  description: string;
  source: string;
  defaultProfiles: string[];
}
interface CoreCatalogGroup {
  id: string;
  label: string;
  source: string;
  pluginId?: string;
  tools: CoreCatalogTool[];
}
interface CoreCatalogResult {
  agentId: string;
  profiles: Array<{ id: string; label: string }>;
  groups: CoreCatalogGroup[];
}
type BuildFn = (params: {
  cfg: unknown;
  agentId?: string;
  includePlugins?: boolean;
}) => CoreCatalogResult;

export interface AgentToolsConfigShape {
  profile?: string;
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
}

export interface AgentCatalogTool {
  id: string;
  label: string;
  description: string;
  source: string;
  /** Effective state under the agent's current tools config. */
  enabled: boolean;
  /** Whether the active profile grants this tool (drives the app's allow/deny delta). */
  inProfile: boolean;
}
export interface AgentCatalogGroup {
  id: string;
  label: string;
  source: string;
  pluginId?: string;
  tools: AgentCatalogTool[];
}
export interface AgentToolsCatalog {
  /** The agent's configured profile (null when unset). */
  profile: string | null;
  profiles: Array<{ id: string; label: string }>;
  groups: AgentCatalogGroup[];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Read an agent's `tools` config block from the host config. */
function findAgentTools(cfg: unknown, agentId: string): AgentToolsConfigShape | undefined {
  const entry = findAgentRosterConfig(cfg, agentId);
  return entry?.tools as AgentToolsConfigShape | undefined;
}

/** Resolve per-tool effective `enabled`/`inProfile` from the agent's `tools` config. */
function projectAgentTools(
  core: CoreCatalogResult,
  cfg: unknown,
  agentId: string,
): AgentToolsCatalog {
  const tools = findAgentTools(cfg, agentId);
  const profile =
    typeof tools?.profile === "string" && tools.profile.trim() ? tools.profile.trim() : null;
  const allow = new Set(readStringArray(tools?.allow));
  const alsoAllow = new Set(readStringArray(tools?.alsoAllow));
  const deny = new Set(readStringArray(tools?.deny));
  // No profile + no explicit allow == core's "allow all (except deny)".
  const allowAll = profile === "full" || allow.has("*") || (!profile && allow.size === 0);

  const groups: AgentCatalogGroup[] = core.groups.map((g) => ({
    id: g.id,
    label: g.label,
    source: g.source,
    pluginId: g.pluginId,
    tools: g.tools.map((t) => {
      const inProfile = allowAll ? true : profile ? t.defaultProfiles.includes(profile) : false;
      let enabled: boolean;
      if (deny.has(t.id)) enabled = false;
      else if (allowAll) enabled = true;
      else enabled = inProfile || allow.has(t.id) || alsoAllow.has(t.id);
      return {
        id: t.id,
        label: t.label,
        description: t.description,
        source: t.source,
        enabled,
        inProfile,
      };
    }),
  }));

  return { profile, profiles: core.profiles, groups };
}

function isCoreCatalogResult(value: unknown): value is CoreCatalogResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { groups?: unknown }).groups) &&
    Array.isArray((value as { profiles?: unknown }).profiles)
  );
}

/**
 * The agent's full tool catalog with per-tool effective state, or null if the gateway
 * `tools.catalog` method is unavailable (outside a plugin request scope, host error).
 * Requires a gateway-authed route: `tools.catalog` needs `operator.read`.
 */
export async function buildAgentToolsCatalog(
  cfg: unknown,
  agentId: string,
): Promise<AgentToolsCatalog | null> {
  let core: unknown;
  try {
    const response = await dispatchGatewayMethod("tools.catalog", {
      agentId,
      includePlugins: true,
    });
    if (!response.ok) return null;
    core = response.payload;
  } catch {
    return null;
  }
  if (!isCoreCatalogResult(core)) return null;
  return projectAgentTools(core, cfg, agentId);
}

/* ─────────────────────────── Legacy (≤2026.9.4) deep-import path ─────────────────────────── */

/**
 * OpenClaw 2026.9.3 moved its bundled chunks from `.js` to `.mjs`. Prefer the
 * current `.mjs` format and likely semantic chunk names so the common path does
 * not synchronously read the entire dist directory, while retaining a broad
 * fallback for future hash/name changes.
 */
export function orderOpenClawDistModuleCandidates(
  files: string[],
  preferredPrefix: string,
): string[] {
  return files
    .filter((file) => {
      if (file.endsWith(".mjs")) return true;
      // OPENCLAW_COMPAT_REMOVE(min-host>=2026.9.3): legacy OpenClaw chunks used `.js`.
      return file.endsWith(".js");
    })
    .map((file, index) => ({ file, index }))
    .sort((a, b) => {
      const preferredDelta =
        Number(!a.file.startsWith(preferredPrefix)) - Number(!b.file.startsWith(preferredPrefix));
      if (preferredDelta !== 0) return preferredDelta;
      const extensionDelta = Number(a.file.endsWith(".js")) - Number(b.file.endsWith(".js"));
      return extensionDelta !== 0 ? extensionDelta : a.index - b.index;
    })
    .map(({ file }) => file);
}

let cachedBuildFn: BuildFn | null | undefined;

async function loadBuildFn(): Promise<BuildFn | null> {
  if (cachedBuildFn !== undefined) return cachedBuildFn;
  cachedBuildFn = await locateBuildFn();
  return cachedBuildFn;
}

/**
 * Core's catalog builder enumerates plugin tools via an internal
 * `ensureStandaloneRuntimePluginRegistryLoaded({ surface: "channel" })`, which
 * `pinActivePluginChannelRegistry()`s a tool-scoped registry that does NOT carry the
 * friday-next channel registration. Because friday-next is an external channel (not in
 * core's static CHANNEL_IDS), that re-pin drops it from the deliverable-channel set for
 * the WHOLE gateway until the next full reload/restart — so every agent `message` send
 * then fails with `Unknown channel: friday-next`. We snapshot the channel registry before
 * the build and pin it back after, neutralizing the side effect. Resilient-import the
 * runtime chunk like the catalog builder (gateway singleton; state lives on globalThis).
 */
interface ChannelRegistryFns {
  get: () => unknown;
  pin: (registry: unknown) => void;
}
let cachedChannelRegistryFns: ChannelRegistryFns | null | undefined;

async function loadChannelRegistryFns(): Promise<ChannelRegistryFns | null> {
  if (cachedChannelRegistryFns !== undefined) return cachedChannelRegistryFns;
  cachedChannelRegistryFns = await locateChannelRegistryFns();
  return cachedChannelRegistryFns;
}

async function locateChannelRegistryFns(): Promise<ChannelRegistryFns | null> {
  const root = resolveOpenClawRoot();
  if (!root) return null;
  const distDir = path.join(root, "dist");
  let files: string[];
  try {
    // OPENCLAW_COMPAT_REMOVE(min-host>=2026.9.3): this registry repair belongs to the
    // legacy `.js` catalog path. The 2026.9.3 `.mjs` builder uses a standalone tool
    // registry and no longer exposes or needs these channel-registry helpers.
    files = fs.readdirSync(distDir).filter((f) => f.endsWith(".js"));
  } catch {
    return null;
  }
  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(distDir, file), "utf8");
    } catch {
      continue;
    }
    // Only the chunk that re-exports both helpers by their real names is usable.
    if (!content.includes("pinActivePluginChannelRegistry")) continue;
    try {
      const mod = (await importAbsoluteModule(path.join(distDir, file))) as Record<string, unknown>;
      const pin = mod.pinActivePluginChannelRegistry;
      const get = mod.getActivePluginChannelRegistry;
      if (typeof pin === "function" && typeof get === "function") {
        return {
          get: get as () => unknown,
          pin: pin as (registry: unknown) => void,
        };
      }
    } catch {
      // unreadable/non-importable candidate → keep scanning
    }
  }
  return null;
}

/**
 * OpenClaw ≥2026.7.1 stopped re-exporting `buildToolsCatalogResult` from the
 * tools-catalog chunk — it now exports only `toolsCatalogHandlers`, the gateway
 * method-handler map (`{"tools.catalog": ({params, respond, context}) => …}`).
 * The handler is synchronous and only reads `context.getRuntimeConfig()`, so we can
 * drive it with our own cfg and capture the respond() payload to recover the exact
 * same catalog the old direct export produced.
 * Exported for tests.
 */
export function adaptToolsCatalogHandler(handler: unknown): BuildFn | null {
  if (typeof handler !== "function") return null;
  return ({ cfg, agentId, includePlugins }) => {
    let result: CoreCatalogResult | undefined;
    let failure: unknown;
    (
      handler as (args: {
        params: unknown;
        respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
        context: { getRuntimeConfig: () => unknown };
      }) => void
    )({
      params: { agentId, includePlugins },
      respond: (ok, payload, error) => {
        if (ok) result = payload as CoreCatalogResult;
        else failure = error;
      },
      context: { getRuntimeConfig: () => cfg },
    });
    if (!result) {
      throw new Error(`tools.catalog handler failed: ${JSON.stringify(failure ?? null)}`);
    }
    return result;
  };
}

async function locateBuildFn(): Promise<BuildFn | null> {
  const root = resolveOpenClawRoot();
  if (!root) return null;
  const distDir = path.join(root, "dist");
  let files: string[];
  try {
    files = orderOpenClawDistModuleCandidates(fs.readdirSync(distDir), "tools-catalog-");
  } catch {
    return null;
  }
  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(distDir, file), "utf8");
    } catch {
      continue;
    }
    if (!content.includes("function buildToolsCatalogResult")) continue;
    try {
      const mod = (await importAbsoluteModule(path.join(distDir, file))) as Record<string, unknown>;
      if (typeof mod.buildToolsCatalogResult === "function")
        return mod.buildToolsCatalogResult as BuildFn;
      // ≥2026.7.1: the builder is module-private; adapt the gateway-method handler map.
      const handlers = mod.toolsCatalogHandlers as Record<string, unknown> | undefined;
      const adapted = adaptToolsCatalogHandler(handlers?.["tools.catalog"]);
      if (adapted) return adapted;
    } catch {
      // unreadable/non-importable candidate → keep scanning
    }
  }
  return null;
}

/**
 * Legacy catalog builder: deep-imports core's dist chunk. Works on ≤2026.9.4; fails on
 * 2026.9.5+ (captured generation lacks `jiti`). Kept for the plugin-authed route that
 * un-upgraded apps call.
 */
export async function buildAgentToolsCatalogLegacy(
  cfg: unknown,
  agentId: string,
): Promise<AgentToolsCatalog | null> {
  const build = await loadBuildFn();
  if (!build) return null;
  // Snapshot the channel registry so we can undo the build's `surface:"channel"` re-pin
  // (which would otherwise drop friday-next from the gateway's deliverable channels).
  const channelFns = await loadChannelRegistryFns();
  const channelRegistryBefore = (() => {
    try {
      return channelFns?.get() ?? null;
    } catch {
      return null;
    }
  })();
  let core: CoreCatalogResult;
  try {
    core = build({ cfg, agentId, includePlugins: true });
  } catch {
    return null;
  } finally {
    // Pin the original channel registry back. Idempotent when the build didn't clobber it
    // (core returns early when the surface already points at this registry).
    if (channelFns && channelRegistryBefore) {
      try {
        channelFns.pin(channelRegistryBefore);
      } catch {
        // best effort — never fail the catalog request over the restore
      }
    }
  }
  return projectAgentTools(core, cfg, agentId);
}

/** Test-only: reset the cached legacy catalog builder. */
export function resetToolCatalogCacheForTest(): void {
  cachedBuildFn = undefined;
}
