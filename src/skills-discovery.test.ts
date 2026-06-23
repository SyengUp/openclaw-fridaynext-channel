import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverAvailableSkills,
  enabledExtensionNames,
  resetOpenClawRootCacheForTest,
} from "./skills-discovery.js";
import {
  setFridayAgentForwardRuntime,
  resetFridayAgentForwardRuntimeForTest,
} from "./agent-forward-runtime.js";

/** Create `<parent>/<id>/SKILL.md` for each id. */
function makeSkills(parent: string, ids: string[]): void {
  for (const id of ids) {
    fs.mkdirSync(path.join(parent, id), { recursive: true });
    fs.writeFileSync(path.join(parent, id, "SKILL.md"), "# " + id);
  }
}

describe("discoverAvailableSkills", () => {
  let root: string;
  let emptyHome: string;
  let savedHome: string | undefined;

  function wire(configRoot: string, cfg: unknown): void {
    setFridayAgentForwardRuntime({
      runtime: {
        agent: {
          session: { resolveStorePath: () => "", loadSessionStore: () => ({}) },
          // main → <configRoot>/workspace ; others → <configRoot>/workspace/agents/<id>
          resolveAgentWorkspaceDir: (_c: unknown, id: string) =>
            id === "main"
              ? path.join(configRoot, "workspace")
              : path.join(configRoot, "workspace", "agents", id),
        },
        config: { current: () => cfg },
      },
    } as never);
  }

  beforeEach(() => {
    // Isolate `~/.agents/skills` (a real discovery source) from the dev machine's
    // home so exact-match assertions don't pick up the operator's actual skills.
    savedHome = process.env.HOME;
    emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "friday-home-"));
    process.env.HOME = emptyHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    resetFridayAgentForwardRuntimeForTest();
    resetOpenClawRootCacheForTest();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (emptyHome) fs.rmSync(emptyHome, { recursive: true, force: true });
  });

  it("scans only the target agent's own workspace (not the default agent's), plus managed + extra dirs, deduped and sorted", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-disc-"));
    const configRoot = path.join(root, "configdir");
    const extraDir = path.join(root, "extra");

    // Default agent "main" workspace — its skills must NOT leak into other agents' catalogs.
    makeSkills(path.join(configRoot, "workspace", "skills"), ["alpha"]);
    // operator's own workspace — opencli also lives in the managed dir below, to prove
    // workspace > installed precedence in dedup.
    makeSkills(path.join(configRoot, "workspace", "agents", "operator", "skills"), [
      "beta",
      "opencli",
    ]);
    // managed dir: <configDir>/skills (sibling of the default workspace)
    makeSkills(path.join(configRoot, "skills"), ["managed-one", "opencli"]);
    // config extraDirs
    makeSkills(extraDir, ["gamma"]);

    const cfg = {
      agents: { list: [{ id: "main", default: true }, { id: "operator" }] },
      skills: { load: { extraDirs: [extraDir] } },
    };
    wire(configRoot, cfg);

    const result = discoverAvailableSkills(cfg, "operator");
    // "alpha" is main-only → absent for operator (regression guard for the main-leak bug).
    expect(result.map((s) => s.id)).toEqual(["beta", "gamma", "managed-one", "opencli"]);
    const bySource = Object.fromEntries(result.map((s) => [s.id, s.source]));
    expect(bySource).toEqual({
      beta: "workspace",
      opencli: "workspace", // workspace wins over the managed-dir duplicate
      "managed-one": "installed",
      gamma: "extra",
    });
  });

  it("ignores directories without SKILL.md", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-disc-"));
    const configRoot = path.join(root, "configdir");
    const skillsDir = path.join(configRoot, "workspace", "skills");
    makeSkills(skillsDir, ["real"]);
    fs.mkdirSync(path.join(skillsDir, "empty-dir"), { recursive: true }); // no SKILL.md

    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    wire(configRoot, cfg);

    expect(discoverAvailableSkills(cfg, "main").map((s) => s.id)).toEqual(["real"]);
  });

  it("uses the SKILL.md frontmatter name over the dir name, and finds nested skills", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-disc-"));
    const configRoot = path.join(root, "configdir");
    const skillsDir = path.join(configRoot, "workspace", "skills");

    // dir name != declared name
    fs.mkdirSync(path.join(skillsDir, "self-improving-agent"), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "self-improving-agent", "SKILL.md"),
      '---\nname: self-improvement\ndescription: "x"\n---\n# body',
    );
    // nested skill (redskill-style): SKILL.md two levels under the skills dir
    const nested = path.join(skillsDir, "luckincoffee-mycoffeeskill", "my-coffee-skill");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "SKILL.md"), "---\nname: my-coffee\n---\n# body");

    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    wire(configRoot, cfg);

    const result = discoverAvailableSkills(cfg, "main");
    expect(result.map((s) => s.id)).toEqual(["my-coffee", "self-improvement"]);
    expect(result.find((s) => s.id === "self-improvement")?.description).toBe("x");
  });

  it("discovers plugin-skills (symlinks), plus project + personal agents skills as 'extra'", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-disc-"));
    const configRoot = path.join(root, "configdir");
    const operatorWs = path.join(configRoot, "workspace", "agents", "operator");

    // target agent's own workspace skills
    makeSkills(path.join(operatorWs, "skills"), ["own-skill"]);
    // project-level agents skills: <workspace>/.agents/skills
    makeSkills(path.join(operatorWs, ".agents", "skills"), ["project-skill"]);
    // personal agents skills: <home>/.agents/skills  (HOME isolated in beforeEach)
    makeSkills(path.join(emptyHome, ".agents", "skills"), ["personal-skill"]);

    // plugin-skills: real plugin skill dirs SYMLINKED into <configDir>/plugin-skills/,
    // exactly how OpenClaw publishes third-party plugin skills (e.g. the miloco-* set).
    const pluginPkg = path.join(root, "miloco-openclaw-plugin", "skills");
    makeSkills(pluginPkg, ["miloco-devices", "miloco-notify"]);
    const pluginSkillsDir = path.join(configRoot, "plugin-skills");
    fs.mkdirSync(pluginSkillsDir, { recursive: true });
    for (const id of ["miloco-devices", "miloco-notify"]) {
      fs.symlinkSync(path.join(pluginPkg, id), path.join(pluginSkillsDir, id), "dir");
    }

    const cfg = { agents: { list: [{ id: "main", default: true }, { id: "operator" }] } };
    wire(configRoot, cfg);

    const result = discoverAvailableSkills(cfg, "operator");
    const bySource = Object.fromEntries(result.map((s) => [s.id, s.source]));
    expect(bySource).toEqual({
      "own-skill": "workspace",
      "project-skill": "extra",
      "personal-skill": "extra",
      "miloco-devices": "extra", // followed through the symlink — the miloco regression
      "miloco-notify": "extra",
    });
  });

  it("returns [] without throwing when nothing is resolvable", () => {
    resetFridayAgentForwardRuntimeForTest();
    expect(discoverAvailableSkills({}, "main")).toEqual([]);
  });
});

describe("enabledExtensionNames", () => {
  it("unions plugins.allow with entries[name].enabled === true", () => {
    const cfg = {
      plugins: {
        allow: ["browser", "canvas"],
        entries: {
          browser: { enabled: true },
          telegram: { enabled: true },
          tavily: { enabled: false },
          "open-prose": {},
        },
      },
    };
    const names = enabledExtensionNames(cfg);
    expect(names.has("browser")).toBe(true);
    expect(names.has("canvas")).toBe(true);
    expect(names.has("telegram")).toBe(true); // from entries.enabled
    expect(names.has("tavily")).toBe(false); // enabled:false
    expect(names.has("open-prose")).toBe(false); // no enabled flag
  });

  it("returns an empty set when plugins config is absent", () => {
    expect(enabledExtensionNames({}).size).toBe(0);
    expect(enabledExtensionNames(undefined).size).toBe(0);
  });
});
