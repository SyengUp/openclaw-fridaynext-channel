import { describe, expect, it } from "vitest";
import {
  agentRosterKind,
  ensureAgentRosterConfig,
  findAgentRosterConfig,
  listAgentRoster,
  resolveRosterDefaultAgentId,
} from "./agent-roster.js";

describe("agentRosterKind", () => {
  it("prefers entries when the key is present", () => {
    expect(
      agentRosterKind({ agents: { entries: { main: {} }, list: [{ id: "stale" }] } }),
    ).toBe("entries");
  });

  it("COMPAT(openclaw<2026.8.1): reads list on a legacy roster", () => {
    expect(agentRosterKind({ agents: { list: [{ id: "main" }] } })).toBe("list");
  });

  it("is none when there is no roster", () => {
    expect(agentRosterKind({ agents: { defaults: {} } })).toBe("none");
    expect(agentRosterKind({})).toBe("none");
  });
});

describe("listAgentRoster / resolveRosterDefaultAgentId", () => {
  it("lists keyed entries and uses the default:true marker", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: {
          main: { name: "F" },
          operator: { name: "Ops", default: true },
        },
      },
    };
    expect(listAgentRoster(cfg).map((a) => a.id)).toEqual(["main", "operator"]);
    expect(resolveRosterDefaultAgentId(cfg)).toBe("operator");
    expect(findAgentRosterConfig(cfg, "MAIN")).toEqual({ name: "F" });
  });

  it("COMPAT(openclaw<2026.8.1): lists a legacy array and defaults to the first id", () => {
    const cfg = { agents: { list: [{ id: "Alpha", model: "x" }, { id: "beta" }] } };
    expect(listAgentRoster(cfg).map((a) => a.id)).toEqual(["alpha", "beta"]);
    expect(resolveRosterDefaultAgentId(cfg)).toBe("alpha");
    expect(findAgentRosterConfig(cfg, "alpha")?.model).toBe("x");
  });

  it("returns main when nothing is configured", () => {
    expect(listAgentRoster({ agents: { defaults: {} } })).toEqual([]);
    expect(resolveRosterDefaultAgentId({ agents: { defaults: {} } })).toBe("main");
  });
});

describe("ensureAgentRosterConfig", () => {
  it("creates an entries row without writing id or list", () => {
    const draft: Record<string, unknown> = {
      agents: { entries: { operator: { name: "Ops" } }, ownership: "explicit" },
    };
    const created = ensureAgentRosterConfig(draft, "main");
    expect(created).toEqual({});
    expect("id" in created).toBe(false);
    expect((draft.agents as { list?: unknown }).list).toBeUndefined();
    expect((draft.agents as { entries: Record<string, unknown> }).entries.main).toBe(created);
    created.tools = { profile: "full" };
    const entries = (draft.agents as { entries: Record<string, Record<string, unknown>> }).entries;
    expect(entries.main.tools).toEqual({ profile: "full" });
  });

  it("reuses an existing entries row", () => {
    const main = { name: "F", skills: ["a"] };
    const draft: Record<string, unknown> = { agents: { entries: { main } } };
    expect(ensureAgentRosterConfig(draft, "main")).toBe(main);
    expect(Object.keys((draft.agents as { entries: object }).entries)).toEqual(["main"]);
  });

  it("COMPAT(openclaw<2026.8.1): materializes a list row for an implicit agent", () => {
    const draft: Record<string, unknown> = { agents: { defaults: {} } };
    const created = ensureAgentRosterConfig(draft, "main");
    expect(created).toEqual({ id: "main" });
    expect((draft.agents as { list: unknown[] }).list).toEqual([{ id: "main" }]);
    expect((draft.agents as { entries?: unknown }).entries).toBeUndefined();
  });
});
