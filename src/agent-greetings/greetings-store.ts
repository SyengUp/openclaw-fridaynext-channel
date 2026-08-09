import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeAgentId } from "../agent-id.js";
import { resolveFridayNextConfig } from "../config.js";
import { getHostOpenClawConfigSnapshot } from "../host-config.js";
import { getFridayNextRuntime } from "../runtime.js";

/**
 * Gateway-side store for per-agent home greetings ("首页问候语").
 *
 * The app's home page typewrites a greeting when the input focuses. Each agent
 * can override it with a custom phrase; storing the override here (instead of
 * only in the app) makes it a property of the *gateway*: every paired device
 * shows the same greeting and a delete+reinstall restores it. Mirrors the
 * server-name store conventions (atomic tmp+rename persist, corrupt file
 * degrades to empty).
 *
 * Deliberately NOT written into `agents.list[]` of the host config: the core's
 * `AgentEntrySchema` is zod `.strict()`, so an unknown `greeting` field would
 * make the gateway fail config validation on the next load. This JSON store is
 * the safe side-channel, exactly like `server-name`.
 *
 * Keyed by normalized agent id; an empty greeting means "no override" — the app
 * then falls back to its localized default ("需要我做什么？" / "How can I help?").
 */

export type AgentGreetingsFile = {
  version: 1;
  /** epoch ms — last-writer-wins bookkeeping across devices */
  updatedAt: number;
  /** agentId (normalized) → custom greeting override */
  greetings: Record<string, string>;
};

export const MAX_GREETING_LEN = 60;

/** Test-only override for the store base directory. */
let testBaseDir: string | null = null;

export function setAgentGreetingsBaseDirForTest(dir: string | null): void {
  testBaseDir = dir;
}

function resolveAgentGreetingsDir(): string {
  if (testBaseDir) return testBaseDir;
  try {
    const cfg = resolveFridayNextConfig(
      getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
    );
    return path.join(path.dirname(cfg.historyDir), "agent-greetings");
  } catch {
    return path.join(os.homedir(), ".openclaw", "friday-next", "agent-greetings");
  }
}

function greetingsFile(): string {
  return path.join(resolveAgentGreetingsDir(), "greetings.json");
}

function emptyFile(): AgentGreetingsFile {
  return { version: 1, updatedAt: 0, greetings: {} };
}

/** Read the persisted greetings map. Missing/corrupt file degrades to empty. */
export function readGreetings(): AgentGreetingsFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(greetingsFile(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return emptyFile();
    const p = parsed as Record<string, unknown>;
    const raw = p.greetings as Record<string, unknown> | undefined;
    const greetings: Record<string, string> = {};
    if (raw && typeof raw === "object") {
      for (const [agentId, value] of Object.entries(raw)) {
        const trimmed = typeof value === "string" ? value.trim() : "";
        if (!trimmed) continue;
        greetings[normalizeAgentId(agentId)] = trimmed;
      }
    }
    return {
      version: 1,
      updatedAt:
        typeof p.updatedAt === "number" && Number.isFinite(p.updatedAt) ? p.updatedAt : 0,
      greetings,
    };
  } catch {
    return emptyFile();
  }
}

/** The custom greeting override for one agent, or undefined when unset. */
export function readGreetingFor(agentId: string): string | undefined {
  return readGreetings().greetings[normalizeAgentId(agentId)];
}

/** Persist a (already validated) greeting for one agent. Empty string clears the override. */
export function setGreeting(agentId: string, greeting: string): AgentGreetingsFile {
  const key = normalizeAgentId(agentId);
  const current = readGreetings();
  const next: Record<string, string> = { ...current.greetings };
  const trimmed = greeting.trim();
  if (trimmed) {
    next[key] = trimmed;
  } else {
    delete next[key];
  }
  const state: AgentGreetingsFile = { version: 1, updatedAt: Date.now(), greetings: next };
  const dir = resolveAgentGreetingsDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = greetingsFile();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, target);
  return state;
}

export type GreetingValidationResult = { ok: true; greeting: string } | { ok: false; error: string };

/** Validate + normalize an inbound `greeting` from a PUT body. Empty string clears the override. */
export function validateGreeting(raw: unknown): GreetingValidationResult {
  if (typeof raw !== "string") return { ok: false, error: "greeting must be a string" };
  const greeting = raw.trim();
  if (greeting.length > MAX_GREETING_LEN) {
    return { ok: false, error: `greeting must be at most ${MAX_GREETING_LEN} characters` };
  }
  return { ok: true, greeting };
}
