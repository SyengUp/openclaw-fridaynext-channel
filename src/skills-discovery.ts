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
 * Sources scanned (deduped by skill id):
 *  1. the agent's own workspace `skills/`
 *  2. the default agent's workspace `skills/`  (the shared root pool non-default
 *     agents also resolve from — e.g. operator inherits `opencli` from here)
 *  3. managed skills dir  (`<configDir>/skills`, sibling of the workspace)
 *  4. config `skills.load.extraDirs`
 *  5. bundled core skills  (`<openclaw>/skills`)
 *  6. bundled extension skills  (`<openclaw>/dist/extensions/<ext>/skills`)
 *
 * A skill's id is the `name:` field in its `SKILL.md` frontmatter (falling back to
 * the containing dir name) — NOT the dir name itself, which often differs (e.g. the
 * `self-improving-agent/` dir declares `name: self-improvement`). Discovery is
 * RECURSIVE (mirroring core's `loadSkills`): some skills nest the `SKILL.md` a few
 * levels deep (e.g. redskill installs at `<pkg>/<sub>/<skill>/SKILL.md`).
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

/** Extract the `name:` value from a SKILL.md YAML frontmatter block. */
function parseSkillName(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") break;
    const m = /^name\s*:\s*(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v.trim() || undefined;
  }
  return undefined;
}

/**
 * Collect skill ids reachable under `root`. A directory containing `SKILL.md` IS a
 * skill (its id = frontmatter `name`, else the dir name) and is not descended into
 * further; other directories are recursed up to a bounded depth. Best-effort.
 */
function collectSkills(root: string, out: Set<string>, depth = 0): void {
  if (depth > MAX_SKILL_WALK_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
    let name: string | undefined;
    try {
      name = parseSkillName(fs.readFileSync(path.join(root, "SKILL.md"), "utf-8"));
    } catch {
      // unreadable frontmatter → fall back to dir name
    }
    out.add(name ?? path.basename(root));
    return; // a skill is a leaf — don't treat its internals as nested skills
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith(".") && !IGNORED_WALK_DIRS.has(e.name)) {
      collectSkills(path.join(root, e.name), out, depth + 1);
    }
  }
}

let cachedOpenClawRoot: string | null | undefined;

/** Locate the installed `openclaw` package root, where bundled skills live. Cached. */
function resolveOpenClawRoot(): string | null {
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

/** Bundled skill dirs inside the openclaw install (core + per-extension). */
function bundledSkillDirs(): string[] {
  const root = resolveOpenClawRoot();
  if (!root) return [];
  const dirs = [path.join(root, "skills")];
  try {
    const extRoot = path.join(root, "dist", "extensions");
    for (const ext of fs.readdirSync(extRoot, { withFileTypes: true })) {
      if (ext.isDirectory()) dirs.push(path.join(extRoot, ext.name, "skills"));
    }
  } catch {
    // no extensions dir on this build
  }
  return dirs;
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
 * Full set of skill ids `agentId` can load, sorted. Aggregates the agent's
 * workspace, the shared root workspace, the managed dir, config extra dirs, and
 * bundled core/extension skills. Every source is optional and failure-tolerant.
 */
export function discoverAvailableSkills(cfg: unknown, agentId: string): string[] {
  const c = cfg as Record<string, unknown> | undefined;
  const resolveWs = getFridayAgentForwardRuntime()?.resolveAgentWorkspaceDir;
  const dirs: string[] = [];

  if (resolveWs) {
    const defaultId = resolveDefaultAgentId(c);
    const ids = agentId === defaultId ? [agentId] : [agentId, defaultId];
    let defaultWs: string | undefined;
    for (const id of ids) {
      try {
        const ws = resolveWs(cfg, id);
        if (ws) {
          dirs.push(path.join(ws, "skills"));
          if (id === defaultId) defaultWs = ws;
        }
      } catch {
        // skip unresolvable workspace
      }
    }
    // Managed skills dir: `<configDir>/skills`, the workspace's parent sibling.
    if (defaultWs) dirs.push(path.join(path.dirname(defaultWs), "skills"));
  }

  const extraDirs = ((c?.skills as Record<string, unknown> | undefined)?.load as
    | Record<string, unknown>
    | undefined)?.extraDirs;
  if (Array.isArray(extraDirs)) {
    for (const d of extraDirs) if (typeof d === "string" && d.trim()) dirs.push(d.trim());
  }

  dirs.push(...bundledSkillDirs());

  const seen = new Set<string>();
  for (const dir of dirs) collectSkills(dir, seen);
  return [...seen].sort();
}

/** Test-only: reset the cached openclaw root. */
export function resetOpenClawRootCacheForTest(): void {
  cachedOpenClawRoot = undefined;
}
