/**
 * Agent roster access that understands both host representations:
 *
 *   - OpenClaw ≥2026.8.1 persists a keyed map at `agents.entries`.
 *   - Older hosts (e.g. 2026.6.11) persist an array at `agents.list`.
 *
 * Core migrates `list` → `entries` on load and the `agents` object is `.strict()`,
 * so writing `list` into an entries-shaped config is dropped (or rejected). The
 * plugin must mutate whichever representation the live snapshot already owns.
 *
 * COMPAT(openclaw<2026.8.1) — the `list` kind. `minHostVersion` stays on the
 * older floor (compat is the point); grep this tag when no install still ships
 * a list-shaped roster (BJ was 2026.6.11 on 2026-08-31). Keep `entries` +
 * implicit-none.
 *
 * Cleanup:
 * 1. Drop `AgentRosterKind` `"list"` and every `kind === "list"` / `agents.list`
 *    branch in this file. `ensureAgentRosterConfig` for a missing row should
 *    always write `agents.entries[id] = {}` (never `{ id }` into `list`).
 * 2. Rewrite list-shaped fixtures tagged COMPAT(openclaw<2026.8.1) to
 *    `agents.entries` (id is the map key; no `id` field inside the object).
 * 3. In `install.js`, drop the `else` that creates `agents.list`.
 */

import { DEFAULT_AGENT_ID, normalizeAgentId } from "./agent-id.js";

/** `"list"` is COMPAT(openclaw<2026.8.1); drop it with the list branches below. */
export type AgentRosterKind = "entries" | "list" | "none";

export type AgentRosterItem = {
  id: string;
  /** Live config object. For `entries`, the id lives on the map key — do not write `id` inside. */
  config: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function agentsBag(cfg: unknown): Record<string, unknown> | undefined {
  if (!isRecord(cfg)) return undefined;
  return isRecord(cfg.agents) ? cfg.agents : undefined;
}

/**
 * Which roster the snapshot owns. `entries` wins when both keys exist (post-migration
 * leftovers): that is the representation 2026.8.1 will persist.
 */
export function agentRosterKind(cfg: unknown): AgentRosterKind {
  const agents = agentsBag(cfg);
  if (!agents) return "none";
  if (Object.hasOwn(agents, "entries") && agents.entries !== undefined) {
    return isRecord(agents.entries) ? "entries" : "none";
  }
  // COMPAT(openclaw<2026.8.1): pre-migration array roster.
  if (Object.hasOwn(agents, "list") && agents.list !== undefined) {
    return Array.isArray(agents.list) ? "list" : "none";
  }
  return "none";
}

/** Unique configured agents, in roster order. Empty when the host has no explicit roster. */
export function listAgentRoster(cfg: unknown): AgentRosterItem[] {
  const kind = agentRosterKind(cfg);
  const agents = agentsBag(cfg);
  if (!agents) return [];
  const seen = new Set<string>();
  const out: AgentRosterItem[] = [];

  if (kind === "entries") {
    for (const [key, value] of Object.entries(agents.entries as Record<string, unknown>)) {
      if (!isRecord(value)) continue;
      const id = normalizeAgentId(key);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, config: value });
    }
    return out;
  }

  // COMPAT(openclaw<2026.8.1): walk `agents.list[]`; id is a field on each row.
  if (kind === "list") {
    for (const entry of agents.list as unknown[]) {
      if (!isRecord(entry)) continue;
      const id = normalizeAgentId(entry.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, config: entry });
    }
  }
  return out;
}

/** Default agent: the `default: true` marker, else the first roster entry, else `main`. */
export function resolveRosterDefaultAgentId(cfg: unknown): string {
  const listed = listAgentRoster(cfg);
  if (listed.length === 0) return DEFAULT_AGENT_ID;
  const marked = listed.find((item) => item.config.default === true);
  return marked?.id ?? listed[0].id;
}

export function findAgentRosterConfig(
  cfg: unknown,
  agentId: string,
): Record<string, unknown> | undefined {
  const id = normalizeAgentId(agentId);
  return listAgentRoster(cfg).find((item) => item.id === id)?.config;
}

/**
 * Return (creating if needed) the mutable config object for `agentId` on `draft`.
 * Creates an `entries` row when the snapshot is entries-shaped; otherwise a `list`
 * row with `{ id }` (legacy implicit-main materialization). Never writes `default: true`.
 */
export function ensureAgentRosterConfig(
  draft: Record<string, unknown>,
  agentId: string,
): Record<string, unknown> {
  const id = normalizeAgentId(agentId);
  const existing = findAgentRosterConfig(draft, id);
  if (existing) return existing;

  const agents = (isRecord(draft.agents) ? draft.agents : (draft.agents = {})) as Record<
    string,
    unknown
  >;

  if (agentRosterKind(draft) === "entries") {
    const entries = agents.entries as Record<string, unknown>;
    const created: Record<string, unknown> = {};
    entries[id] = created;
    return created;
  }

  // COMPAT(openclaw<2026.8.1): list-shaped roster, or implicit main with no roster —
  // materialize `{ id }` in `agents.list`. 2026.8.1+ must write `entries[id] = {}` instead.
  const list = (
    Array.isArray(agents.list) ? agents.list : (agents.list = [])
  ) as Array<Record<string, unknown>>;
  const created: Record<string, unknown> = { id };
  list.push(created);
  return created;
}
