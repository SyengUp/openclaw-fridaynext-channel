/**
 * Discover the full catalog of skills an agent can load — the selectable set the
 * app's skill-management UI offers, matching what OpenClaw's ControlUI shows.
 *
 * OpenClaw resolves an agent's loadable skills from several directories. None of
 * the core's skill-discovery functions are reachable through a stable plugin-sdk
 * specifier (they live only in hash-named chunks), so instead of deep-importing
 * brittle core code we scan the same DIRECTORIES core scans — a far more stable
 * coupling (directory conventions change far less often than bundled chunk names),
 * and every access is guarded so a missing/renamed source just yields fewer skills
 * rather than an error. A skill is a sub-directory containing `SKILL.md` (the same
 * marker core's `loadSkillsFromDir` uses).
 *
 * Each discovered skill is tagged with a `source` category for the UI:
 *  - workspace : the agent's own + the shared default-agent workspace `skills/`
 *  - installed : managed skills dir (`<configDir>/skills`, sibling of the workspace)
 *  - built-in  : bundled core skills (`<openclaw>/skills`)
 *  - extra     : skills from ENABLED extensions (`<openclaw>/dist/extensions/<ext>/skills`,
 *                gated by `plugins.allow`/`entries.enabled` like ControlUI) + config
 *                `skills.load.extraDirs` — mirrors ControlUI's "EXTRA" bucket
 *                (core tags extension skills `source: "extension"`).
 *
 * Dedup is by skill id, first source wins (workspace > installed > extra > built-in).
 *
 * A skill's id is the `name:` field in its `SKILL.md` frontmatter (falling back to
 * the containing dir name) — NOT the dir name itself, which often differs (e.g. the
 * `self-improving-agent/` dir declares `name: self-improvement`). The `description:`
 * frontmatter field is surfaced too. Discovery is RECURSIVE (mirroring core's
 * `loadSkills`): some skills nest the `SKILL.md` a few levels deep (e.g. redskill
 * installs at `<pkg>/<sub>/<skill>/SKILL.md`).
 *
 * NOT included (out of scope for a name catalog): ClawHub remote-only skills and
 * per-skill eligibility/`disabled` flags. The enabled set is the agent's own
 * `skills[]` config, already returned separately by the config view.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { getFridayAgentForwardRuntime } from "./agent-forward-runtime.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "./agent-id.js";

/** Depth limit for the recursive walk under each source dir (skills nest a few levels). */
const MAX_SKILL_WALK_DEPTH = 6;
const IGNORED_WALK_DIRS = new Set(["node_modules", ".git"]);

export type SkillSource = "workspace" | "built-in" | "installed" | "extra";

export interface DiscoveredSkill {
  id: string;
  description?: string;
  source: SkillSource;
}

/** Extract `name`/`description` from a SKILL.md YAML frontmatter block. */
function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  let name: string | undefined;
  let description: string | undefined;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") break;
    const m = /^(name|description)\s*:\s*(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    v = v.trim();
    if (!v) continue;
    if (m[1] === "name" && name === undefined) name = v;
    else if (m[1] === "description" && description === undefined) description = v;
  }
  return { name, description };
}

/**
 * Collect skills reachable under `root`, tagging each with `source`. A directory
 * containing `SKILL.md` IS a skill (id = frontmatter `name`, else dir name) and is
 * not descended into further; other directories are recursed up to a bounded depth.
 * First occurrence of an id wins (call higher-priority sources first). Best-effort.
 */
function collectSkills(root: string, source: SkillSource, out: Map<string, DiscoveredSkill>, depth = 0): void {
  if (depth > MAX_SKILL_WALK_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
    let fm: { name?: string; description?: string } = {};
    try {
      fm = parseSkillFrontmatter(fs.readFileSync(path.join(root, "SKILL.md"), "utf-8"));
    } catch {
      // unreadable frontmatter → fall back to dir name, no description
    }
    const id = fm.name ?? path.basename(root);
    if (!out.has(id)) out.set(id, { id, description: fm.description, source });
    return; // a skill is a leaf — don't treat its internals as nested skills
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith(".") && !IGNORED_WALK_DIRS.has(e.name)) {
      collectSkills(path.join(root, e.name), source, out, depth + 1);
    }
  }
}

let cachedOpenClawRoot: string | null | undefined;

/** Locate the installed `openclaw` package root (cached). Shared with tool-catalog discovery. */
export function resolveOpenClawRoot(): string | null {
  if (cachedOpenClawRoot !== undefined) return cachedOpenClawRoot;
  cachedOpenClawRoot = computeOpenClawRoot();
  return cachedOpenClawRoot;
}

function computeOpenClawRoot(): string | null {
  const starts: string[] = [];
  // Primary: resolve a subpath this plugin already imports (works inside the gateway
  // where `openclaw/*` is resolvable). Standalone (e.g. unit tests) this throws → skipped.
  try {
    starts.push(createRequire(import.meta.url).resolve("openclaw/plugin-sdk/plugin-entry"));
  } catch {
    // not resolvable outside the gateway runtime
  }
  // Fallback: the gateway process entry (`<openclaw>/dist/index.js`) — the plugin runs in it.
  if (typeof process.argv[1] === "string") starts.push(process.argv[1]);

  for (const start of starts) {
    let dir = path.dirname(start);
    for (let i = 0; i < 10 && dir !== path.dirname(dir); i++) {
      try {
        const pkgPath = path.join(dir, "package.json");
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { name?: string };
        if (pkg?.name === "openclaw") return dir;
      } catch {
        // keep walking up
      }
      dir = path.dirname(dir);
    }
  }
  return null;
}

/**
 * The set of bundled extensions enabled for this install — `plugins.allow` plus any
 * `plugins.entries[name].enabled === true`. ControlUI only surfaces skills from
 * enabled extensions, so we gate on the same set (extension dir name == plugin id).
 */
export function enabledExtensionNames(cfg: unknown): Set<string> {
  const plugins = (cfg as Record<string, unknown> | undefined)?.plugins as Record<string, unknown> | undefined;
  const names = new Set<string>();
  const allow = plugins?.allow;
  if (Array.isArray(allow)) for (const n of allow) if (typeof n === "string") names.add(n);
  const entries = plugins?.entries as Record<string, unknown> | undefined;
  if (entries && typeof entries === "object") {
    for (const [name, val] of Object.entries(entries)) {
      if (val && typeof val === "object" && (val as Record<string, unknown>).enabled === true) names.add(name);
    }
  }
  return names;
}

/**
 * Bundled skill source dirs inside the openclaw install, tagged like ControlUI:
 * core `<openclaw>/skills` → "built-in"; per-extension `dist/extensions/<ext>/skills`
 * → "extra" (core tags these `source: "extension"`). Extension skills are included
 * only when the extension is enabled, matching ControlUI's EXTRA bucket.
 */
function bundledSkillSources(enabledExtensions: Set<string>): Array<{ dir: string; source: SkillSource }> {
  const root = resolveOpenClawRoot();
  if (!root) return [];
  const out: Array<{ dir: string; source: SkillSource }> = [
    { dir: path.join(root, "skills"), source: "built-in" },
  ];
  try {
    const extRoot = path.join(root, "dist", "extensions");
    for (const ext of fs.readdirSync(extRoot, { withFileTypes: true })) {
      if (ext.isDirectory() && enabledExtensions.has(ext.name)) {
        out.push({ dir: path.join(extRoot, ext.name, "skills"), source: "extra" });
      }
    }
  } catch {
    // no extensions dir on this build
  }
  return out;
}

function resolveDefaultAgentId(cfg: Record<string, unknown> | undefined): string {
  const list = (cfg?.agents as Record<string, unknown> | undefined)?.list as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(list) && list.length > 0) {
    const def = list.find((a) => a?.default === true) ?? list[0];
    if (def?.id) return normalizeAgentId(def.id);
  }
  return DEFAULT_AGENT_ID;
}

/**
 * Full set of skills `agentId` can load, sorted by id, each tagged with its source
 * category. Aggregates the agent's workspace, the shared root workspace, the managed
 * dir, config extra dirs, and bundled core/extension skills. Every source is optional
 * and failure-tolerant.
 */
export function discoverAvailableSkills(cfg: unknown, agentId: string): DiscoveredSkill[] {
  const c = cfg as Record<string, unknown> | undefined;
  const resolveWs = getFridayAgentForwardRuntime()?.resolveAgentWorkspaceDir;
  const sources: Array<{ dir: string; source: SkillSource }> = [];

  if (resolveWs) {
    const defaultId = resolveDefaultAgentId(c);
    const ids = agentId === defaultId ? [agentId] : [agentId, defaultId];
    let defaultWs: string | undefined;
    for (const id of ids) {
      try {
        const ws = resolveWs(cfg, id);
        if (ws) {
          sources.push({ dir: path.join(ws, "skills"), source: "workspace" });
          if (id === defaultId) defaultWs = ws;
        }
      } catch {
        // skip unresolvable workspace
      }
    }
    // Managed skills dir: `<configDir>/skills`, the workspace's parent sibling.
    if (defaultWs) sources.push({ dir: path.join(path.dirname(defaultWs), "skills"), source: "installed" });
  }

  const extraDirs = ((c?.skills as Record<string, unknown> | undefined)?.load as
    | Record<string, unknown>
    | undefined)?.extraDirs;
  if (Array.isArray(extraDirs)) {
    for (const d of extraDirs) if (typeof d === "string" && d.trim()) sources.push({ dir: d.trim(), source: "extra" });
  }

  sources.push(...bundledSkillSources(enabledExtensionNames(c)));

  const out = new Map<string, DiscoveredSkill>();
  for (const { dir, source } of sources) collectSkills(dir, source, out, 0);
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Test-only: reset the cached openclaw root. */
export function resetOpenClawRootCacheForTest(): void {
  cachedOpenClawRoot = undefined;
}
