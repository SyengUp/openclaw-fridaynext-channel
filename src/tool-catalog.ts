/**
 * Build an agent's tool-permission catalog for the app's toolbox editor — the same
 * tools/categories/descriptions/profiles ControlUI shows.
 *
 * The catalog (core + plugin tools, grouped, with descriptions and per-tool
 * `defaultProfiles`) is produced by core's `buildToolsCatalogResult({cfg, agentId})`.
 * That builder lives only in a hash-named dist chunk (no stable plugin-sdk export) and
 * the catalog is CODE, not scannable data — so unlike skill discovery we can't avoid
 * importing it. We locate the chunk RESILIENTLY (scan `<openclaw>/dist/*.js` for the one
 * defining `buildToolsCatalogResult`, then dynamic-import it — Node returns the gateway's
 * already-loaded module instance, so no side effects), cache it, and degrade gracefully
 * (null) if the layout changes. Per-tool `enabled`/`inProfile` are then resolved here from
 * the agent's `tools` config so the app can render simple toggles.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveOpenClawRoot } from "./skills-discovery.js";
import { normalizeAgentId } from "./agent-id.js";

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
type BuildFn = (params: { cfg: unknown; agentId?: string; includePlugins?: boolean }) => CoreCatalogResult;

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
      const mod = (await import(path.join(distDir, file))) as Record<string, unknown>;
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

async function locateBuildFn(): Promise<BuildFn | null> {
  const root = resolveOpenClawRoot();
  if (!root) return null;
  const distDir = path.join(root, "dist");
  let files: string[];
  try {
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
    if (!content.includes("function buildToolsCatalogResult")) continue;
    try {
      const mod = (await import(path.join(distDir, file))) as Record<string, unknown>;
      if (typeof mod.buildToolsCatalogResult === "function") return mod.buildToolsCatalogResult as BuildFn;
    } catch {
      // unreadable/non-importable candidate → keep scanning
    }
  }
  return null;
}

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
  const list = ((cfg as Record<string, unknown> | undefined)?.agents as Record<string, unknown> | undefined)
    ?.list as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(list)) return undefined;
  const entry = list.find((a) => a && typeof a === "object" && normalizeAgentId(a.id) === agentId);
  return entry?.tools as AgentToolsConfigShape | undefined;
}

/**
 * The agent's full tool catalog with per-tool effective state, or null if the core
 * catalog builder can't be located.
 */
export async function buildAgentToolsCatalog(cfg: unknown, agentId: string): Promise<AgentToolsCatalog | null> {
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

  const tools = findAgentTools(cfg, agentId);
  const profile = (typeof tools?.profile === "string" && tools.profile.trim()) ? tools.profile.trim() : null;
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

/** Test-only: reset the cached catalog builder. */
export function resetToolCatalogCacheForTest(): void {
  cachedBuildFn = undefined;
}
